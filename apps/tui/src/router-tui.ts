// zhgg — live router TUI dashboard
// Subscribes to RouterEventBus events and renders 4 panels in real time
// using raw ANSI. Each frame is built as a single string and written once
// to avoid tearing on slow terminals.

import { buildMockStack, type Mode, type RouteResult } from '@zhgg/router';

// ── ANSI ──────────────────────────────────────────────────────────────────────

const E = '\x1b';
const ESC = (s: string) => `${E}[${s}`;
const at = (r: number, c: number) => ESC(`${r};${c}H`);
const fg = (r: number, g: number, b: number) => ESC(`38;2;${r};${g};${b}m`);
const reset = ESC('0m');
const clearScreen = ESC('2J') + at(1, 1);
const hideCursor = ESC('?25l');
const showCursor = ESC('?25h');
const eraseEol = ESC('K');
// Length math must ignore ANSI escapes — they don't occupy display cells.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
function visibleLen(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

const c = {
  reset,
  bold: ESC('1m'),
  dim: ESC('2m'),
  green: fg(0, 255, 136),
  dgreen: fg(0, 140, 75),
  gray: fg(120, 125, 135),
  dgray: fg(60, 65, 70),
  white: fg(220, 225, 235),
  yellow: fg(255, 210, 55),
  red: fg(255, 80, 80),
  indigo: fg(140, 130, 255),
  amber: fg(245, 158, 11),
};

// ── Layout ────────────────────────────────────────────────────────────────────

const W = () => process.stdout.columns || 100;
const H = () => process.stdout.rows || 30;
const SPLIT = () => Math.floor(W() * 0.5);
const MIN_W = 80;
const MIN_H = 24;

// Row zones (1-indexed)
const HEADER_ROW = 1;
const SEP1_ROW = 2;
const PANEL_HEADER = 3;
const PANEL_TOP = 4;
const PANEL_BOTTOM = () => H() - 6;
const SETTLE_HEADER = () => H() - 5;
const SETTLE_BAR = () => H() - 4;
const FOOTER_SEP = () => H() - 2;
const FOOTER = () => H() - 1;

// ── State ─────────────────────────────────────────────────────────────────────

interface RoutingLine {
  text: string;
  detail: string;
}

interface AuditLine {
  text: string;
}

const HEADLINES: ReadonlyArray<{ text: string; mode: Mode }> = [
  { text: 'Markets fall on tariff fears', mode: 'fast' },
  { text: 'Fed holds rates, signals caution', mode: 'fast' },
  { text: 'Ethereum ETF volumes surge 40%', mode: 'fast' },
  { text: 'DAO votes to allocate 500 ETH to treasury', mode: 'consensus' },
  { text: 'Smart contract upgrade proposal passes', mode: 'consensus' },
];

// One audit row per headline, mutated in place when its CID flushes.
const auditLines: AuditLine[] = HEADLINES.map((h) => ({
  text: `pending…  ${pad(h.mode, 9)}`,
}));
const routingLines: RoutingLine[] = [];
let settlementCount = 0;
let lowConfidenceCount = 0;
let footer = 'idle';
let agentLine = '';

const TOTAL_SETTLEMENTS = HEADLINES.reduce(
  (sum, h) => sum + (h.mode === 'consensus' ? 3 : 1),
  0,
);

// ── Format helpers ────────────────────────────────────────────────────────────

function pad(s: string, n: number): string {
  const len = visibleLen(s);
  if (len >= n) {
    // Truncation must respect ANSI — for now, just trim raw chars from the
    // visible end. Inputs to pad() that contain colour are responsible for
    // ensuring `n` is sized to fit the visible portion.
    let cut = '';
    let acc = 0;
    for (let i = 0; i < s.length && acc < n; i++) {
      cut += s[i];
      const ch = s[i]!;
      if (ch === E) {
        const m = ANSI_RE.exec(s.slice(i));
        ANSI_RE.lastIndex = 0;
        if (m && m.index === 0) {
          cut += s.slice(i + 1, i + m[0].length);
          i += m[0].length - 1;
          continue;
        }
      }
      acc += 1;
    }
    return cut;
  }
  return s + ' '.repeat(n - len);
}

function repeat(s: string, n: number): string {
  return n <= 0 ? '' : s.repeat(n);
}

function fmtUsd(n: number): string {
  return '$' + n.toFixed(6);
}

function fmtMs(n: number): string {
  return `${Math.round(n)}ms`;
}

function fmtHash(h: string | null): string {
  if (h === null) return '—';
  if (h.length <= 16) return h;
  return `${h.slice(0, 10)}…${h.slice(-4)}`;
}

// ── Frame builder (one string, one write) ─────────────────────────────────────

function buildFrame(): string {
  const out: string[] = [clearScreen];
  const w = W();
  const split = SPLIT();
  const colWidth = w - split;

  // Header
  const title = `${c.green}${c.bold}zhgg${c.reset}${c.gray} — live router${c.reset}`;
  const right = `${c.dim}${c.gray}MODE: mock${c.reset}`;
  const titleVisible = visibleLen(title);
  const rightVisible = visibleLen(right);
  const gap = Math.max(1, w - titleVisible - rightVisible);
  out.push(at(HEADER_ROW, 1) + title + ' '.repeat(gap) + right);
  if (agentLine) {
    out.push(at(HEADER_ROW, 1) + eraseEol);
    out.push(at(HEADER_ROW, 1) + c.gray + 'agent  ' + c.white + agentLine + c.reset);
  }

  // Top separator
  out.push(at(SEP1_ROW, 1) + c.dgray + repeat('─', w) + c.reset);

  // Panel headers
  out.push(at(PANEL_HEADER, 1) + c.bold + c.indigo + ' LIVE ROUTING' + c.reset);
  out.push(at(PANEL_HEADER, split + 1) + c.bold + c.indigo + ' AUDIT LOG' + c.reset);

  // Routing panel (each entry = 2 rows)
  const startRow = PANEL_TOP;
  const endRow = PANEL_BOTTOM();
  const maxLines = endRow - startRow + 1;
  const visibleEntries = routingLines.slice(-Math.floor(maxLines / 2));
  let row = startRow;
  for (const line of visibleEntries) {
    if (row > endRow) break;
    out.push(at(row, 1) + ' '.repeat(split));
    out.push(at(row, 2) + pad(line.text, split - 2));
    row += 1;
    if (row > endRow) break;
    out.push(at(row, 1) + ' '.repeat(split));
    out.push(at(row, 4) + c.dim + c.gray + pad(line.detail, split - 4) + c.reset);
    row += 1;
  }
  // Blank remaining routing rows
  for (let r = row; r <= endRow; r++) {
    out.push(at(r, 1) + ' '.repeat(split));
  }

  // Audit panel
  const auditVisible = auditLines.slice(-(maxLines));
  let aRow = startRow;
  for (const a of auditVisible) {
    if (aRow > endRow) break;
    out.push(at(aRow, split + 1) + ' '.repeat(colWidth));
    out.push(at(aRow, split + 2) + c.dim + c.gray + pad(a.text, colWidth - 2) + c.reset);
    aRow += 1;
  }
  for (let r = aRow; r <= endRow; r++) {
    out.push(at(r, split + 1) + ' '.repeat(colWidth));
  }

  // Bottom separator + settlement bar
  out.push(at(FOOTER_SEP() - 4, 1) + c.dgray + repeat('─', w) + c.reset);
  out.push(at(SETTLE_HEADER(), 1) + c.bold + c.amber + ' KEEPERHUB SETTLEMENTS' + c.reset);
  const dotsGreen = c.green + '●'.repeat(settlementCount) + c.reset;
  const dotsDim = c.dgray + '●'.repeat(Math.max(0, TOTAL_SETTLEMENTS - settlementCount)) + c.reset;
  const settleStatus = `${c.gray}  ${settlementCount}/${TOTAL_SETTLEMENTS} confirmed${c.reset}`;
  out.push(at(SETTLE_BAR(), 1) + ' ' + dotsGreen + dotsDim + settleStatus);

  // Footer
  out.push(at(FOOTER_SEP(), 1) + c.dgray + repeat('─', w) + c.reset);
  out.push(at(FOOTER(), 1) + ' '.repeat(w));
  out.push(at(FOOTER(), 1) + c.dim + c.gray + '> ' + footer + c.reset);

  return out.join('');
}

let renderScheduled = false;
function paint(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  // Coalesce within a tick — multiple state changes that happen synchronously
  // produce one frame instead of N.
  queueMicrotask(() => {
    renderScheduled = false;
    process.stdout.write(buildFrame());
  });
}

// Demo stack imported from @zhgg/router/testing/mock-stack — single source of truth.
// 120ms inference delay so the TUI animation is observable to a human viewer.
function buildStack() {
  return buildMockStack({ delayMs: 120 });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (W() < MIN_W || H() < MIN_H) {
    process.stdout.write(
      `${c.red}terminal too small (${W()}×${H()}); resize to ≥${MIN_W}×${MIN_H}${c.reset}\n`,
    );
    process.exit(1);
  }

  process.stdout.write(clearScreen + hideCursor);
  agentLine = 'agent.zhgg.eth · iNFT #1 · 0G Galileo';
  footer = 'starting...';
  paint();

  const { router, audit, scope } = buildStack();

  // Track which audit row corresponds to which headline so we can mutate
  // the placeholder in place when the CID lands.
  let currentIndex = 0;

  router.events.on('route.providers_selected', (p) => {
    footer = `route.providers_selected (${p.providers.map((x) => x.id).join(', ')})`;
    paint();
  });
  router.events.on('route.inference_start', (p) => {
    footer = `route.inference_start ${p.mode} → ${p.provider.id}`;
    paint();
  });
  router.events.on('route.settlement_complete', () => {
    settlementCount += 1;
    paint();
  });
  router.events.on('route.consensus_scored', (p) => {
    if (p.low_confidence) lowConfidenceCount += 1;
    footer = `route.consensus_scored agreement=${(p.agreement_score * 100).toFixed(0)}%${p.low_confidence ? ' (low)' : ''}`;
    paint();
  });
  router.events.on('route.audit_flushed', (p) => {
    // Mutate the slot already reserved for currentIndex in place.
    if (currentIndex < auditLines.length) {
      const slot = auditLines[currentIndex]!;
      slot.text = `${fmtHash(p.audit_cid)}  ${slot.text.replace(/^pending…\s+/, '')}`;
    }
    paint();
  });

  process.stdout.on('resize', paint);

  for (let i = 0; i < HEADLINES.length; i++) {
    currentIndex = i;
    const h = HEADLINES[i]!;
    footer = `[${i + 1}/${HEADLINES.length}] routing: ${h.text}`;
    paint();

    const r = await router.route(
      {
        prompt: `Classify this crypto headline: "${h.text}"`,
        mode: h.mode,
        max_cost_usd: 0.005,
        max_latency_ms: 5000,
        output_type: 'categorical',
      },
      scope,
    );

    if (r.ok) {
      const route: RouteResult = r.value;
      const head = `${c.bold}[${i + 1}] ${route.mode}${c.reset} → ${c.indigo}${route.provider_ids.join(', ')}${c.reset}`;
      const lowFlag = route.low_confidence ? ` ${c.amber}⚠${c.reset}` : '';
      const agree =
        route.agreement_score !== null
          ? ` · ${(route.agreement_score * 100).toFixed(0)}%${lowFlag}`
          : '';
      const detail = `${c.green}${route.response}${c.reset} ${c.gray}${fmtUsd(route.cost_usd)} · ${fmtMs(route.latency_ms)}${agree}${c.reset}`;
      routingLines.push({ text: head, detail });
      // Update audit row's mode + cost portion (cid will be filled by listener).
      auditLines[i] = {
        text: `pending…  ${pad(route.mode, 9)} ${pad(fmtUsd(route.cost_usd), 11)}`,
      };
      paint();
    } else {
      routingLines.push({
        text: `${c.red}[${i + 1}] FAILED${c.reset}`,
        detail: c.red + r.error.kind + c.reset,
      });
      paint();
    }

    // Force flush so audit_cid lands in the panel before the next headline.
    await audit.flush();
  }

  await audit.close();
  footer = `complete · ${HEADLINES.length}/${HEADLINES.length} · ${settlementCount} settlements${lowConfidenceCount > 0 ? ` · ${lowConfidenceCount} low-confidence` : ''} · press Ctrl+C to exit`;
  paint();
}

const cleanup = (): void => {
  process.stdout.write(showCursor + reset + '\n');
  process.exit(0);
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

main().catch((err: unknown) => {
  process.stdout.write(showCursor + reset + '\n');
  const reason = err instanceof Error ? err.message : String(err);
  console.error(`router-tui failed: ${reason}`);
  process.exit(1);
});
