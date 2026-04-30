/// Splits panel — rolling buffer of ERC-8021-tagged fee distributions.
///
/// Each event is a single split: one inbound payment fanning out to four
/// recipients (85% owner / 5% keeperhub / 5% zhgg / 5% commons). Rendered
/// in 10-row scrollback, newest first.

const E = '\x1b';
const RESET = `${E}[0m`;
const DIM = `${E}[2m`;
const BOLD = `${E}[1m`;
const GREEN = `${E}[38;2;0;255;136m`;
const CYAN = `${E}[38;2;100;200;255m`;

export interface SplitEvent {
  /// Wall-clock ms since the agents-tui session started.
  tMs: number;
  /// Total amount distributed (atomic units of the asset).
  totalAtomic: string;
  /// Asset symbol (e.g. "USDC") for display.
  asset: string;
  /// Recipient address of the agent owner (gets 85%).
  ownerAddress: string;
  /// Originating context (e.g. "audit→oracle", "user→audit").
  context: string;
}

const MAX_ROWS = 10;

function fmtTime(ms: number): string {
  return `[T+${(ms / 1000).toFixed(1)}s]`.padEnd(8);
}

function fmtAddr(a: string): string {
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function fmtAmount(atomic: string, decimals = 6): string {
  const big = BigInt(atomic);
  const denom = 10n ** BigInt(decimals);
  const whole = big / denom;
  const frac = big % denom;
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, 4);
  return `${whole.toString()}.${fracStr}`;
}

export function renderSplitsPanel(events: readonly SplitEvent[]): string {
  const lines: string[] = [];
  lines.push(`${BOLD}ERC-8021 SPLITS${RESET} ${DIM}(${events.length} events, latest ${MAX_ROWS})${RESET}`);
  lines.push(`${DIM}${'─'.repeat(60)}${RESET}`);
  if (events.length === 0) {
    lines.push(`${DIM}  (no splits yet)${RESET}`);
    return lines.join('\n');
  }
  // Latest first; cap at MAX_ROWS.
  const slice = events.slice(-MAX_ROWS).reverse();
  for (const ev of slice) {
    const ts = `${DIM}${fmtTime(ev.tMs)}${RESET}`;
    const total = fmtAmount(ev.totalAtomic);
    const owner = fmtAddr(ev.ownerAddress);
    // 85/5/5/5 derived from total
    const ownerCut = ((Number(total) * 0.85)).toFixed(4);
    const sliceFee = ((Number(total) * 0.05)).toFixed(4);
    const ctx = ev.context.length > 18 ? ev.context.slice(0, 15) + '...' : ev.context.padEnd(18);
    lines.push(
      `  ${ts} ${ctx} ${GREEN}${total} ${ev.asset}${RESET} ` +
        `${DIM}→${RESET} ${CYAN}${ownerCut}${RESET} ${DIM}owner ${owner}${RESET}` +
        ` ${DIM}+ 3 × ${sliceFee} (keeper/zhgg/commons)${RESET}`
    );
  }
  return lines.join('\n');
}

export function pushSplit(buffer: SplitEvent[], ev: SplitEvent): SplitEvent[] {
  const next = [...buffer, ev];
  if (next.length > MAX_ROWS * 4) {
    // Hard cap on memory growth — keep the latest 4× the rendered rows.
    return next.slice(-MAX_ROWS * 4);
  }
  return next;
}
