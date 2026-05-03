// ── Audit trail buffer + disk persistence ────────────────────────────────────
//
// Module-scope ring buffer of orchestrator + dispatcher events. Each row is
// also appended to ~/.zhgg/audit.jsonl so sessions survive restarts.
// Bounded to 400 rows in memory; the file grows unbounded (user can delete).

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const ZHGG_DIR = join(homedir(), '.zhgg');
const AUDIT_FILE = join(ZHGG_DIR, 'audit.jsonl');
const RECEIPT_FILE = join(ZHGG_DIR, 'receipt.json');

function ensureDir() {
  if (!existsSync(ZHGG_DIR)) mkdirSync(ZHGG_DIR, { recursive: true });
}

export interface AuditRow {
  time: string;
  agent: string;
  event: string;
  ok: 'ok' | 'err' | 'info';
  // ISO date string (YYYY-MM-DD) — used to filter out rows from previous days on load
  date?: string;
  // epoch ms — row renders with a pop-in highlight until this time expires
  flashUntil: number;
}

export const AUDIT: AuditRow[] = [];

// Load rows from disk on startup — today's rows only. Rows from previous
// days are stale and confuse the operator (old failures mixed with live events).
export function loadAuditFromDisk(): void {
  try {
    if (!existsSync(AUDIT_FILE)) return;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const lines = readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').filter(Boolean);
    // Read from the tail — no need to parse the whole file
    const tail = lines.slice(-400);
    for (const line of tail) {
      try {
        const row = JSON.parse(line) as Omit<AuditRow, 'flashUntil'>;
        // Skip rows from previous days (old sessions)
        if (row.date && row.date !== today) continue;
        AUDIT.push({ ...row, flashUntil: 0 }); // loaded rows don't flash
      } catch { /* skip malformed */ }
    }
  } catch { /* file unreadable — start fresh */ }
}

export function pushAudit(agent: string, event: string, ok: AuditRow['ok'] = 'info'): void {
  const now = new Date();
  const row: AuditRow = {
    time: now.toLocaleTimeString('en-GB').slice(0, 8),
    date: now.toISOString().slice(0, 10), // YYYY-MM-DD
    agent,
    event,
    ok,
    flashUntil: Date.now() + 2000,
  };
  AUDIT.push(row);
  if (AUDIT.length > 400) AUDIT.splice(0, AUDIT.length - 400);

  // Persist to disk — skip 'system' rows (session noise, not audit events)
  if (agent !== 'system') {
    try {
      ensureDir();
      const { flashUntil: _f, ...storable } = row;
      appendFileSync(AUDIT_FILE, JSON.stringify(storable) + '\n');
    } catch { /* disk write failure is non-fatal */ }
  }
}

// Persist the receipt envelope whenever it changes.
export function saveReceiptToDisk(envelope: unknown): void {
  try {
    ensureDir();
    writeFileSync(RECEIPT_FILE, JSON.stringify(envelope, null, 2));
  } catch { /* non-fatal */ }
}

// Load the last saved receipt on startup. Returns null when none exists.
export function loadReceiptFromDisk(): unknown | null {
  try {
    if (!existsSync(RECEIPT_FILE)) return null;
    return JSON.parse(readFileSync(RECEIPT_FILE, 'utf8'));
  } catch { return null; }
}
