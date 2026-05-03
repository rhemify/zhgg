/// Pure state reducer for the cinematic spotlight CLI. The terminal
/// shows ONE morphing verdict-confidence line; this module owns the
/// derivation of that line from orchestrator events. No I/O, no ANSI —
/// `render.ts` turns a `SpotlightState` into a frame.
///
/// Phases:
///   idle      — pre-dispatch (the seed frame)
///   running   — audit in flight; probes resolving in parallel
///   complete  — verdict known; proof artifacts revealing
///   failed    — orchestrator threw or audit was cancelled
///
/// Confidence is derived, never stored as a free variable. The render
/// loop animates the *displayed* number by lerping toward the state's
/// target on each frame (kept in `render.ts`, not here).

import type { Verdict } from '@zhgg/audit-agent';

export type Phase = 'idle' | 'running' | 'complete' | 'failed';

export interface ProbeRow {
  ref: string;
  status: 'pending' | 'pass' | 'fail';
  finding: string;
}

export interface SpotlightState {
  phase: Phase;
  target: string;
  probes: { total: number; passed: number; failed: number };
  verdict: Verdict | null;
  costUsd: number;
  trail: ProbeRow[];
  /// Proof artifacts — only revealed when `phase === 'complete'`.
  reportUri: string | null;
  reportHash: string | null;
  paymentTx: string | null;
  receiptTx: string | null;
  attestationRoot: string | null;
  startedAt: number;
  /// Optional human-readable reason on `phase === 'failed'`. Surfaces in
  /// the spotlight as the failure caption.
  failureReason: string | null;
}

export type SpotlightEvent =
  | { type: 'audit.start'; target: string; probesTotal: number; probeRefs: string[] }
  | { type: 'probe.complete'; ref: string; pass: boolean; finding: string; costUsd: number }
  | { type: 'audit.complete'; verdict: Verdict; findings: string[] }
  | { type: 'audit.failed'; reason: string }
  | { type: 'audit.report.pin'; uri: string; hash: string }
  | { type: 'audit.receipt.post'; txHash: string }
  | { type: 'oracle.payment.settle'; txHash: string }
  | { type: 'audit.attestation'; root: string };

export function initialState(target: string, now: number): SpotlightState {
  return {
    phase: 'idle',
    target,
    probes: { total: 0, passed: 0, failed: 0 },
    verdict: null,
    costUsd: 0,
    trail: [],
    reportUri: null,
    reportHash: null,
    paymentTx: null,
    receiptTx: null,
    attestationRoot: null,
    startedAt: now,
    failureReason: null,
  };
}

export function reduce(state: SpotlightState, ev: SpotlightEvent): SpotlightState {
  switch (ev.type) {
    case 'audit.start':
      return {
        ...state,
        phase: 'running',
        target: ev.target,
        probes: { total: ev.probesTotal, passed: 0, failed: 0 },
        trail: ev.probeRefs.map((ref) => ({ ref, status: 'pending' as const, finding: '' })),
      };
    case 'probe.complete': {
      const trail = state.trail.map((row) =>
        row.ref === ev.ref
          ? { ...row, status: ev.pass ? ('pass' as const) : ('fail' as const), finding: ev.finding }
          : row
      );
      return {
        ...state,
        probes: {
          ...state.probes,
          passed: state.probes.passed + (ev.pass ? 1 : 0),
          failed: state.probes.failed + (ev.pass ? 0 : 1),
        },
        costUsd: state.costUsd + ev.costUsd,
        trail,
      };
    }
    case 'audit.complete':
      return { ...state, phase: 'complete', verdict: ev.verdict };
    case 'audit.failed':
      return { ...state, phase: 'failed', failureReason: ev.reason };
    case 'audit.report.pin':
      return { ...state, reportUri: ev.uri, reportHash: ev.hash };
    case 'audit.receipt.post':
      return { ...state, receiptTx: ev.txHash };
    case 'oracle.payment.settle':
      return { ...state, paymentTx: ev.txHash };
    case 'audit.attestation':
      return { ...state, attestationRoot: ev.root };
  }
}

/// Target confidence (0-100) — what the rendered number should animate
/// toward. The render loop lerps the displayed value to close this gap
/// over ~250ms (asymmetric: faster on rises, snap on conclusion).
export function targetConfidence(state: SpotlightState): number {
  if (state.phase === 'idle') return 0;
  if (state.phase === 'failed') return 0;
  const { total, passed, failed } = state.probes;
  const done = passed + failed;
  if (state.phase === 'running') {
    if (total === 0) return 30;
    // Climb 30 → 80 as probes pass; sag toward 25 if any fail.
    const passShare = passed / total;
    const failPenalty = failed * 12;
    return Math.max(15, 30 + passShare * 50 - failPenalty);
  }
  // complete
  switch (state.verdict) {
    case 'compliant':
      return 95;
    case 'non_compliant':
      return 95;
    case 'unclear':
      return 50;
    default:
      return done > 0 ? 60 : 30;
  }
}

export type VerdictLabel =
  | 'idle'
  | 'analyzing'
  | 'leaning compliant'
  | 'leaning non-compliant'
  | 'mixed signal'
  | 'COMPLIANT'
  | 'NON-COMPLIANT'
  | 'UNCLEAR'
  | 'FAILED';

export function verdictLabel(state: SpotlightState): VerdictLabel {
  if (state.phase === 'idle') return 'idle';
  if (state.phase === 'failed') return 'FAILED';
  if (state.phase === 'complete') {
    if (state.verdict === 'compliant') return 'COMPLIANT';
    if (state.verdict === 'non_compliant') return 'NON-COMPLIANT';
    return 'UNCLEAR';
  }
  // running
  const { passed, failed } = state.probes;
  if (passed === 0 && failed === 0) return 'analyzing';
  if (passed > 0 && failed === 0) return 'leaning compliant';
  if (failed > 0 && passed === 0) return 'leaning non-compliant';
  return 'mixed signal';
}

export type VerdictGlyph = ' ' | '◯' | '◐' | '●' | '✕';

export function verdictGlyph(state: SpotlightState): VerdictGlyph {
  if (state.phase === 'idle') return ' ';
  if (state.phase === 'failed') return '✕';
  if (state.phase === 'complete') return '●';
  // running
  const done = state.probes.passed + state.probes.failed;
  if (done === 0) return '◯';
  return '◐';
}
