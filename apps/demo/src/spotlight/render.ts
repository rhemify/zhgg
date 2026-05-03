/// Pure renderer for the cinematic spotlight CLI. Takes a state, the
/// currently *displayed* confidence (the runtime lerps this toward the
/// state's target each frame), and produces an ordered array of visible
/// lines plus an ANSI-painted frame. Two outputs so tests can assert on
/// the plain content without sweeping ANSI escape minutiae.
///
/// Visual contract (the design brief):
///   - Single accent: verdict glyph + label color the only colored thing
///   - Trail rows are dim — they are the past, not the focus
///   - Proof artifacts (CID, tx hashes) only render in `complete` phase
///   - No borders, no panels, no boxes — content carries the weight

import {
  targetConfidence,
  verdictGlyph,
  verdictLabel,
  type SpotlightState,
} from './state.js';

const C_RESET = '\x1b[0m';
const C_DIM = '\x1b[2m';
const C_BRIGHT = '\x1b[1m';
const C_GREEN = '\x1b[32m';
const C_AMBER = '\x1b[33m';
const C_RED = '\x1b[31m';
const C_GRAY = '\x1b[90m';
const C_WHITE = '\x1b[37m';

/// One frame's worth of plain-text lines (centered already, no ANSI).
/// Tests snapshot these. The runtime calls `paint()` which returns the
/// same lines with positioning + color escape sequences applied.
export interface Frame {
  lines: string[];
}

const COL_WIDTH = 76;

function center(text: string, width = COL_WIDTH): string {
  const pad = Math.max(0, Math.floor((width - text.length) / 2));
  return ' '.repeat(pad) + text;
}

function shortHash(h: string | null, width = 18): string {
  if (!h) return '—';
  if (h.length <= width) return h;
  const head = Math.max(6, Math.floor((width - 1) / 2));
  const tail = Math.max(4, width - head - 1);
  return `${h.slice(0, head)}…${h.slice(-tail)}`;
}

function verdictColor(state: SpotlightState): string {
  if (state.phase === 'failed') return C_RED;
  if (state.phase === 'complete') {
    if (state.verdict === 'compliant') return C_GREEN;
    if (state.verdict === 'non_compliant') return C_RED;
    return C_AMBER;
  }
  // running
  const { passed, failed } = state.probes;
  if (failed > 0 && passed === 0) return C_RED;
  if (passed > 0 && failed === 0) return C_AMBER;
  if (passed > 0 && failed > 0) return C_AMBER;
  return C_WHITE;
}

/// Verdict + confidence string. The displayed confidence is passed in
/// because the runtime lerps the rendered number toward
/// `targetConfidence(state)` over a few frames, while the verdict label
/// itself derives from state directly.
export function verdictLine(state: SpotlightState, displayedConfidence: number): string {
  const glyph = verdictGlyph(state);
  const label = verdictLabel(state);
  if (state.phase === 'idle') {
    return '';
  }
  const { total, passed, failed } = state.probes;
  const done = passed + failed;
  const conf = Math.round(Math.max(0, Math.min(100, displayedConfidence)));
  if (state.phase === 'complete' || state.phase === 'failed') {
    if (state.phase === 'failed') return `${glyph}  ${label}`;
    return `${glyph}  ${label} · ${done}/${total} probes · ${conf}%`;
  }
  // running
  if (done === 0) {
    return `${glyph}  ${label} ${state.target}`;
  }
  return `${glyph}  ${label} · ${done}/${total} probes · ${conf}%`;
}

function probeRowText(row: { ref: string; status: 'pending' | 'pass' | 'fail'; finding: string }): string {
  const mark = row.status === 'pass' ? '✓' : row.status === 'fail' ? '✕' : '◯';
  const labelPad = row.ref.padEnd(12);
  const finding = row.status === 'pending' ? 'analyzing…' : truncate(row.finding, 48);
  return `  ${mark} ${labelPad} ${finding}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function costLine(state: SpotlightState): string {
  if (state.phase === 'idle') return '';
  const dollars = state.costUsd === 0 ? '—' : `$${state.costUsd.toFixed(4)}`;
  const done = state.probes.passed + state.probes.failed;
  const probesLabel = state.probes.total === 0 ? '' : ` · ${done} probes`;
  return `${dollars}${probesLabel}`;
}

/// Render the spotlight to ordered plain-text lines (no ANSI). Tests
/// snapshot this; the runtime composes ANSI-colored equivalents via
/// `paintLines`.
export function renderLines(state: SpotlightState, displayedConfidence: number): Frame {
  const lines: string[] = [];
  // Top breathing room
  lines.push('');
  lines.push('');
  lines.push('');

  // The verdict line — center stage
  lines.push(center(verdictLine(state, displayedConfidence)));
  lines.push('');

  // Probe trail (dim) — runs while audit is in flight + stays after
  if (state.phase !== 'idle' && state.trail.length > 0) {
    lines.push('');
    for (const row of state.trail) {
      lines.push(center(probeRowText(row)));
    }
    lines.push('');
  }

  // Cost grounding — only visible during/after running
  if (state.phase !== 'idle') {
    lines.push(center(costLine(state)));
  }

  // Proof reveal — only in complete phase
  if (state.phase === 'complete') {
    lines.push('');
    lines.push('');
    if (state.reportUri) {
      lines.push(center(`audit report   ${shortHash(state.reportUri, 36)}`));
    }
    if (state.reportHash) {
      lines.push(center(`report hash    ${shortHash(state.reportHash, 36)}`));
    }
    if (state.paymentTx) {
      lines.push(center(`payment tx     ${shortHash(state.paymentTx, 36)}`));
    }
    if (state.receiptTx) {
      lines.push(center(`receipt tx     ${shortHash(state.receiptTx, 36)}`));
    }
    if (state.attestationRoot) {
      lines.push(center(`attestation    ${shortHash(state.attestationRoot, 36)}`));
    }
  }

  // Failure caption — replaces the proof block on the failed path
  if (state.phase === 'failed' && state.failureReason) {
    lines.push('');
    lines.push(center(state.failureReason));
  }

  return { lines };
}

/// Apply ANSI to the rendered lines — verdict gets color + bright,
/// probe rows are dim, proof rows are gray. The runtime wraps the
/// result with the screen-clear + cursor-home + cursor-hide escapes.
export function paintLines(state: SpotlightState, displayedConfidence: number): string[] {
  const { lines } = renderLines(state, displayedConfidence);
  const verdictPlain = verdictLine(state, displayedConfidence);
  const verdictColored = verdictPlain
    ? `${verdictColor(state)}${C_BRIGHT}${verdictPlain}${C_RESET}`
    : '';
  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed === verdictPlain) {
      return line.replace(verdictPlain, verdictColored);
    }
    if (trimmed.startsWith('✓ ') || trimmed.startsWith('✕ ') || trimmed.startsWith('◯ ')) {
      return `${C_DIM}${line}${C_RESET}`;
    }
    if (
      trimmed.startsWith('audit report') ||
      trimmed.startsWith('report hash') ||
      trimmed.startsWith('payment tx') ||
      trimmed.startsWith('receipt tx') ||
      trimmed.startsWith('attestation')
    ) {
      return `${C_GRAY}${line}${C_RESET}`;
    }
    if (trimmed.startsWith('$') || trimmed === '—' || trimmed.includes(' probes')) {
      return `${C_DIM}${line}${C_RESET}`;
    }
    if (state.phase === 'failed' && state.failureReason && trimmed === state.failureReason) {
      return `${C_RED}${line}${C_RESET}`;
    }
    return line;
  });
}

/// Compose a full ANSI frame: clear screen, hide cursor, paint lines,
/// pad to terminal height. Stateless w.r.t. the runtime — tests can
/// drive this through a series of states to capture the morph.
export function paintFrame(
  state: SpotlightState,
  displayedConfidence: number,
  termRows = 30
): string {
  const painted = paintLines(state, displayedConfidence);
  const padded = [...painted];
  while (padded.length < termRows - 1) padded.push('');
  return `\x1b[2J\x1b[H\x1b[?25l${padded.join('\n')}\n`;
}
