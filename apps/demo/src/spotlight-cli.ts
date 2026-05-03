#!/usr/bin/env bun
/// Cinematic spotlight CLI — replaces the static 4-pane TUI with a
/// single morphing verdict-confidence line. The operator types one
/// command, watches one signal, sees the proof revealed at the end.
///
/// Usage:
///   bun run apps/demo/src/spotlight-cli.ts <ens>
///   bun run apps/demo/src/spotlight-cli.ts oracle.zhgg.eth
///
/// Architecture:
///   - State (state.ts) and renderer (render.ts) are pure + tested
///   - This file owns the runtime: it wraps the synthetic infer impl to
///     emit per-probe events the orchestrator never produces, subscribes
///     to runCrossAgentDemo events, lerps the displayed confidence, and
///     drives a 30 fps render loop. Cleanup on Ctrl-C restores the
///     terminal state.
///
/// Design contract (the brief): single accent color, asymmetric motion
/// (slow morph on rises, snap on conclusion), proof artifacts revealed
/// only after the verdict lands. No borders, no panels, no JSON.

import { EventEmitter } from 'node:events';
import { runCrossAgentDemo, type TranscriptStep } from './cross-agent.js';
import { syntheticInferImpl } from './live-deps-mock.js';
import { PROBE_PROMPTS } from '@zhgg/audit-agent';
import type { AuditDeps } from '@zhgg/audit-agent';
import type {
  Erc8004Client,
  PostError,
  Result,
  SettleOutput,
  ZGInferenceResult,
  ZGRouterError,
} from '@zhgg/workflow';
import {
  initialState,
  reduce,
  targetConfidence,
  type SpotlightState,
} from './spotlight/state.js';
import { paintFrame } from './spotlight/render.js';

const PROBE_REFS = PROBE_PROMPTS.map((p) => p.articleRef.replace(/ \(.*\)$/, ''));

const MOCK_RECEIPT_HASH = '0x6d6f636b00000000000000000000000000000000000000000000000000000001' as const;
const MOCK_PAYMENT_HASH = '0x6d6f636b00000000000000000000000000000000000000000000000000000002' as const;
const MOCK_PAYER = '0x6d6f636b00000000000000000000000000000000' as const;

const MOCK_SETTLEMENT: SettleOutput = {
  txHash: MOCK_PAYMENT_HASH,
  network: 'eip155:84532',
  payer: MOCK_PAYER,
  rail: 'direct_split',
};

interface ProbePassthrough {
  ref: string;
  pass: boolean;
  finding: string;
  cost: number;
}

function parseProbePassthrough(value: ZGInferenceResult, ref: string): ProbePassthrough {
  let pass = false;
  let finding = 'analyzing';
  try {
    const parsed = JSON.parse(value.response) as { compliant?: boolean; finding?: string };
    pass = parsed.compliant === true;
    finding = parsed.finding ?? finding;
  } catch {
    finding = 'unparseable response';
  }
  return { ref, pass, finding, cost: value.cost_usd };
}

/// Wrap the synthetic infer impl so each probe completion fires a
/// `spotlight.probe.complete` event. We pair each call with a probe ref
/// in PROBE_PROMPTS order — runAudit fires probes in parallel via
/// `PROBE_PROMPTS.map`, so the ith call corresponds to PROBE_REFS[i].
/// A small staggered delay ensures probes don't all resolve in the same
/// render frame, which would skip the morph entirely.
function buildSpotlightInfer(events: EventEmitter): AuditDeps['infer'] {
  let probeIndex = 0;
  return async (prompt, opts) => {
    const ref = PROBE_REFS[probeIndex] ?? `Probe ${probeIndex + 1}`;
    probeIndex += 1;
    // Stagger probes so the morph is visible: 0.7s, 1.5s, 2.4s
    const delay = 600 + probeIndex * 800;
    await new Promise((resolve) => setTimeout(resolve, delay));
    const r = await syntheticInferImpl(prompt, opts);
    if (r.ok) {
      const passthrough = parseProbePassthrough(r.value, ref);
      events.emit('spotlight.probe.complete', passthrough);
    } else {
      events.emit('spotlight.probe.complete', {
        ref,
        pass: false,
        finding: `inference failed: ${r.error.kind}`,
        cost: 0,
      });
    }
    return r;
  };
}

const noopPostReceipt = async (): Promise<Result<`0x${string}`, PostError>> => ({
  ok: true,
  value: MOCK_RECEIPT_HASH,
});

const noopErc8004: Erc8004Client = {
  giveFeedback: async () => MOCK_RECEIPT_HASH,
};

interface RuntimeOptions {
  target: string;
  /// Frame rate for the render loop. 30fps gives a buttery morph; tests
  /// override to 0 to make the lerp deterministic.
  fps?: number;
  /// When set, write frames here instead of stdout. Used by tests to
  /// capture the rendered output without poking the real terminal.
  out?: NodeJS.WriteStream;
}

export interface RuntimeResult {
  exitCode: number;
  finalState: SpotlightState;
}

export async function runSpotlight(opts: RuntimeOptions): Promise<RuntimeResult> {
  const out = opts.out ?? process.stdout;
  const fps = opts.fps ?? 30;
  const start = Date.now();

  let state = initialState(opts.target, start);
  let displayedConfidence = 0;

  const events = new EventEmitter();

  const handle = (type: string, fn: (payload: unknown) => void) => events.on(type, fn);

  // Orchestrator events → state mutations
  handle('audit.start', () => {
    state = reduce(state, {
      type: 'audit.start',
      target: opts.target,
      probesTotal: PROBE_REFS.length,
      probeRefs: PROBE_REFS,
    });
  });
  handle('spotlight.probe.complete', (raw) => {
    const p = raw as ProbePassthrough;
    state = reduce(state, {
      type: 'probe.complete',
      ref: p.ref,
      pass: p.pass,
      finding: p.finding,
      costUsd: p.cost,
    });
  });
  handle('audit.complete', (raw) => {
    const step = raw as TranscriptStep;
    const verdict = (step.detail?.verdict as SpotlightState['verdict']) ?? 'unclear';
    const findings = (step.detail?.findings as string[]) ?? [];
    state = reduce(state, { type: 'audit.complete', verdict: verdict ?? 'unclear', findings });
  });
  handle('audit.failed', (raw) => {
    const step = raw as TranscriptStep;
    const reason = (step.detail?.reason as string) ?? 'unknown failure';
    state = reduce(state, { type: 'audit.failed', reason });
  });
  handle('audit.report.pin', (raw) => {
    const step = raw as TranscriptStep;
    const uri = (step.detail?.uri as string) ?? '';
    const hash = (step.detail?.hash as string) ?? '';
    if (uri || hash) state = reduce(state, { type: 'audit.report.pin', uri, hash });
  });
  handle('audit.receipt.post', (raw) => {
    const step = raw as TranscriptStep;
    const txHash = (step.detail?.txHash as string) ?? '';
    if (txHash) state = reduce(state, { type: 'audit.receipt.post', txHash });
  });
  handle('oracle.payment.settle', (raw) => {
    const step = raw as TranscriptStep;
    const txHash = (step.detail?.txHash as string) ?? '';
    if (txHash) state = reduce(state, { type: 'oracle.payment.settle', txHash });
  });

  // Render loop — runs while the demo is in flight
  const tick = () => {
    const target = targetConfidence(state);
    // Asymmetric lerp: rise faster than fall, snap on terminal phases
    if (state.phase === 'complete' || state.phase === 'failed') {
      displayedConfidence = target;
    } else if (target > displayedConfidence) {
      displayedConfidence += Math.max(1, (target - displayedConfidence) * 0.18);
    } else {
      displayedConfidence += (target - displayedConfidence) * 0.08;
    }
    out.write(paintFrame(state, displayedConfidence));
  };

  let interval: ReturnType<typeof setInterval> | null = null;
  if (fps > 0) {
    interval = setInterval(tick, Math.floor(1000 / fps));
  }

  // Cursor + signal cleanup
  const restore = () => {
    if (interval) clearInterval(interval);
    out.write('\x1b[?25h\x1b[0m\n');
  };
  process.on('SIGINT', () => {
    restore();
    process.exit(130);
  });

  // Run the demo. We pass our own EventEmitter so we receive the
  // orchestrator's events live (subscribing after the fact would miss
  // events that fired during the await).
  const auditDeps: AuditDeps = {
    infer: buildSpotlightInfer(events),
    postReceipt: noopPostReceipt,
    erc8004Client: noopErc8004,
  };

  let exitCode = 0;
  try {
    await runCrossAgentDemo(
      {
        settleOraclePayment: async () => MOCK_SETTLEMENT,
        auditDeps,
      },
      {
        target: {
          agentId: 7n,
          agentName: opts.target,
          manifest: `placeholder manifest for ${opts.target}`,
        },
        oracleTopic: 'eu-ai-act',
        auditOptions: {
          apiKey: process.env.ZG_ROUTER_KEY ?? 'sk-mock',
          registryAddress: '0x1111111111111111111111111111111111111111',
          agentRegistryCaip: 'eip155:16602:0x1111111111111111111111111111111111111111',
          clientAddress: 'eip155:84532:0x2222222222222222222222222222222222222222',
          now: new Date().toISOString(),
          quorum: 'majority',
        },
        events,
      }
    );
  } catch (err) {
    state = reduce(state, {
      type: 'audit.failed',
      reason: err instanceof Error ? err.message : String(err),
    });
    exitCode = 1;
  }

  // One last frame at terminal confidence so the proof block lands.
  tick();
  // Hold the final frame for a beat so the audience can read it.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  restore();
  return { exitCode, finalState: state };
}

// Direct-invoke entrypoint
if (import.meta.main) {
  const target = process.argv[2] ?? 'oracle.zhgg.eth';
  runSpotlight({ target })
    .then((r) => process.exit(r.exitCode))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
