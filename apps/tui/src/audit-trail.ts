// ── Audit trail buffer ───────────────────────────────────────────────────────
//
// Module-scope ring buffer of orchestrator + dispatcher events. Bounded
// to 400 rows so memory doesn't grow under long sessions. Render reads
// from the same array directly — no extra subscription wiring needed.

export interface AuditRow {
  time: string;
  agent: string;
  event: string;
  ok: 'ok' | 'err' | 'info';
}

export const AUDIT: AuditRow[] = [];

export function pushAudit(agent: string, event: string, ok: AuditRow['ok'] = 'info'): void {
  AUDIT.push({
    time: new Date().toLocaleTimeString('en-GB').slice(0, 8),
    agent,
    event,
    ok,
  });
  // Keep the buffer bounded so memory doesn't grow under long sessions.
  if (AUDIT.length > 400) AUDIT.splice(0, AUDIT.length - 400);
}
