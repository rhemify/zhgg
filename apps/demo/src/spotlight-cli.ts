#!/usr/bin/env bun
/// Cinematic spotlight CLI — strict in-place line animation for the
/// audit intent. The whole UI during execution is ONE line, rewritten
/// in place via `\r\x1b[2K`. Once the verdict lands, that line gets
/// committed (`\n`) and the evidence + receipts blocks render below it,
/// strictly left-aligned with a 2-space prefix.
///
/// Usage:
///   bun run apps/demo/src/spotlight-cli.ts <ens>
///   bun run apps/demo/src/spotlight-cli.ts oracle.zhgg.eth
///
/// No-mock policy: this runtime refuses to start without the same env
/// `--live` mode requires. Earlier revisions silently fell back to
/// `0x6d6f636b…` ("mock" in ASCII) hashes — that's been removed. The
/// only mocks left are the `__depsOverride` escape hatch the unit test
/// uses to keep coverage without standing up a real testnet client.

import { EventEmitter } from 'node:events';
import {
  runCrossAgentDemo,
  type CrossAgentDemoDeps,
  type TranscriptStep,
} from './cross-agent.js';
import { buildLiveDeps, readLiveConfigFromEnv } from './live-deps.js';
import { PROBE_PROMPTS } from '@zhgg/audit-agent';
import type { AuditDeps, Verdict } from '@zhgg/audit-agent';
import type { ZGInferenceResult } from '@zhgg/workflow';
import {
  initialState,
  reduce,
  verdictGlyph,
  verdictLabel,
  targetConfidence,
  type SpotlightState,
} from './spotlight/state.js';

/// Stripped probe refs — `EU AI Act Article 5 (Regulation 2024/1689)` →
/// `Article 5`. The original ref is what runAudit sees; this short form
/// is what the audience reads.
const PROBE_REFS = PROBE_PROMPTS.map((p) =>
  p.articleRef.replace(/^EU AI Act /, '').replace(/ \(.*\)$/, '')
);

// ─── ANSI ─────────────────────────────────────────────────────────────
const C_RESET = '\x1b[0m';
const C_DIM = '\x1b[2m';
const C_BRIGHT = '\x1b[1m';
const C_GREEN = '\x1b[32m';
const C_AMBER = '\x1b[33m';
const C_RED = '\x1b[31m';
const C_GRAY = '\x1b[90m';
/// Clear current line + move cursor to column 0. The canonical sequence
/// for in-place line animation in any sane terminal.
const CLEAR_LINE = '\r\x1b[2K';

// ─── Probe-event wiring ───────────────────────────────────────────────

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

/// Wrap any AuditDeps['infer'] so each call emits a per-probe event the
/// orchestrator's runAudit doesn't natively produce. Probes run in
/// parallel via PROBE_PROMPTS.map, so the i-th call pairs with
/// PROBE_REFS[i]. Stagger delays make the morph visible — without them,
/// 3 probes resolve in the same tick and the operator sees the verdict
/// jump straight from ◯ to ●.
function buildSpotlightInfer(
  base: AuditDeps['infer'],
  events: EventEmitter
): AuditDeps['infer'] {
  let probeIndex = 0;
  return async (prompt, opts) => {
    const ref = PROBE_REFS[probeIndex] ?? `Probe ${probeIndex + 1}`;
    probeIndex += 1;
    // 0.7s, 1.5s, 2.4s stagger — enough for the eye, short enough for a
    // 3-minute demo budget.
    const delay = 600 + probeIndex * 800;
    await new Promise((resolve) => setTimeout(resolve, delay));
    const r = await base(prompt, opts);
    if (r.ok) {
      events.emit('spotlight.probe.complete', parseProbePassthrough(r.value, ref));
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

// ─── Verdict-line composition (matches user's exact spec) ────────────

function verdictColor(state: SpotlightState): string {
  if (state.phase === 'failed') return `${C_BRIGHT}${C_RED}`;
  if (state.phase === 'complete') {
    if (state.verdict === 'compliant') return `${C_BRIGHT}${C_GREEN}`;
    if (state.verdict === 'non_compliant') return `${C_BRIGHT}${C_RED}`;
    return `${C_BRIGHT}${C_AMBER}`;
  }
  // Running — non-bold; only the final verdict gets bold per spec
  const { passed, failed } = state.probes;
  if (failed > 0) return C_RED;
  if (passed > 0) return C_AMBER;
  return C_DIM;
}

function verdictLine(state: SpotlightState): string {
  if (state.phase === 'idle') return '';
  const glyph = verdictGlyph(state);
  const label = verdictLabel(state);
  const conf = Math.round(targetConfidence(state));
  const { passed, failed, total } = state.probes;
  const done = passed + failed;
  if (state.phase === 'failed') return `${glyph} ${label}`;
  if (state.phase === 'complete') return `${glyph} ${label} · ${done}/${total} probes pass · ${conf}%`;
  if (done === 0) return `${glyph} analyzing ${state.target}`;
  return `${glyph} ${label} · ${done}/${total} probes pass · ${conf}%`;
}

function shortHash(h: string | null | undefined, width = 24): string {
  if (!h) return '—';
  if (h.length <= width) return h;
  const head = Math.floor((width - 1) / 2);
  const tail = width - head - 1;
  return `${h.slice(0, head)}…${h.slice(-tail)}`;
}

// ─── Runtime ──────────────────────────────────────────────────────────

export interface SpotlightDepsBundle {
  deps: CrossAgentDemoDeps;
  auditOptions: {
    apiKey: string;
    registryAddress: `0x${string}`;
    agentRegistryCaip: string;
    clientAddress: string;
    quorum?: 'all' | 'majority';
    now?: string;
  };
}

interface RuntimeOptions {
  target: string;
  /// Override stdout — tests pipe a capture stream here.
  out?: NodeJS.WriteStream;
  /// Test-only escape hatch: pre-built deps + auditOptions skip env
  /// reading. Production callers MUST omit this — the spotlight refuses
  /// to start without live env when this is undefined.
  __depsOverride?: SpotlightDepsBundle;
}

export interface RuntimeResult {
  exitCode: number;
  finalState: SpotlightState;
}

function writeEnvHelp(out: NodeJS.WriteStream, missingMessage: string): void {
  out.write(`\n${C_BRIGHT}${C_RED}spotlight refuses to run without live env${C_RESET}\n`);
  out.write(`  ${missingMessage}\n\n`);
  out.write(`${C_DIM}required env (set in your shell or a .env this process can read):${C_RESET}\n`);
  out.write(`${C_DIM}  ZG_ROUTER_KEY              sk-... (fund via "bun run scripts/fund-zg-router.ts 3")${C_RESET}\n`);
  out.write(`${C_DIM}  BASE_SEPOLIA_PRIVATE_KEY   0x... (64 hex)${C_RESET}\n`);
  out.write(`${C_DIM}  ZG_PRIVATE_KEY             0x... (64 hex)${C_RESET}\n`);
  out.write(`${C_DIM}  BASE_SEPOLIA_RPC_URL       https://sepolia.base.org${C_RESET}\n`);
  out.write(`${C_DIM}  ZG_RPC_URL                 https://evmrpc-testnet.0g.ai${C_RESET}\n`);
  out.write(`${C_DIM}  FEE_SPLITTER_ADDRESS       0x...${C_RESET}\n`);
  out.write(`${C_DIM}  AGENT_REGISTRY_ADDRESS     0x...${C_RESET}\n`);
  out.write(`${C_DIM}  ORACLE_OWNER_ADDRESS       0x...${C_RESET}\n\n`);
  out.write(`${C_DIM}for an offline transcript without live testnet, use:${C_RESET}\n`);
  out.write(`${C_DIM}  bun run apps/demo/src/cross-agent-cli.ts oracle.zhgg.eth${C_RESET}\n\n`);
}

export async function runSpotlight(opts: RuntimeOptions): Promise<RuntimeResult> {
  const out = opts.out ?? process.stdout;
  const start = Date.now();
  let state = initialState(opts.target, start);

  // Resolve deps: env-driven by default, override for tests only.
  let bundle: SpotlightDepsBundle;
  if (opts.__depsOverride) {
    bundle = opts.__depsOverride;
  } else {
    let cfg;
    try {
      cfg = readLiveConfigFromEnv();
    } catch (e) {
      writeEnvHelp(out, e instanceof Error ? e.message : String(e));
      return { exitCode: 1, finalState: state };
    }
    if (!cfg.zgRouterKey) {
      writeEnvHelp(
        out,
        'ZG_ROUTER_KEY missing — silent mock would emit 0x6d6f636b… hashes that look real'
      );
      return { exitCode: 1, finalState: state };
    }
    const live = buildLiveDeps(cfg);
    bundle = { deps: live.deps, auditOptions: live.auditOptions };
  }

  const events = new EventEmitter();

  // Wrap infer to inject per-probe events
  const wrappedInfer = buildSpotlightInfer(bundle.deps.auditDeps.infer, events);
  const wrappedDeps: CrossAgentDemoDeps = {
    ...bundle.deps,
    auditDeps: { ...bundle.deps.auditDeps, infer: wrappedInfer },
  };

  // ─── Render primitives ─────────────────────────────────────────────
  const repaintVerdict = () => {
    const line = verdictLine(state);
    if (!line) return;
    out.write(`${CLEAR_LINE}  ${verdictColor(state)}${line}${C_RESET}`);
  };

  const writeBlank = () => out.write('\n');

  const writeSectionHeader = (label: string) => {
    out.write(`${C_DIM}  ${label}${C_RESET}\n`);
  };

  const writeProbeRow = (
    ref: string,
    status: 'pass' | 'fail',
    finding: string
  ) => {
    const mark = status === 'pass' ? `${C_GREEN}✓${C_RESET}` : `${C_RED}✕${C_RESET}`;
    const truncated = finding.length > 56 ? finding.slice(0, 55) + '…' : finding;
    out.write(`  ${mark} ${C_DIM}${ref}: ${truncated}${C_RESET}\n`);
  };

  const writeKv = (key: string, value: string) => {
    out.write(`  ${C_DIM}${key.padEnd(12)} ${value}${C_RESET}\n`);
  };

  // ─── Event handlers ────────────────────────────────────────────────
  events.on('audit.start', () => {
    state = reduce(state, {
      type: 'audit.start',
      target: opts.target,
      probesTotal: PROBE_REFS.length,
      probeRefs: PROBE_REFS,
    });
    repaintVerdict();
  });

  events.on('spotlight.probe.complete', (raw: ProbePassthrough) => {
    state = reduce(state, {
      type: 'probe.complete',
      ref: raw.ref,
      pass: raw.pass,
      finding: raw.finding,
      costUsd: raw.cost,
    });
    repaintVerdict();
  });

  events.on('audit.complete', (step: TranscriptStep) => {
    const verdict = (step.detail?.verdict as Verdict | undefined) ?? 'unclear';
    const findings = (step.detail?.findings as string[] | undefined) ?? [];
    state = reduce(state, { type: 'audit.complete', verdict, findings });
    // Final morph + commit the verdict line with a newline
    repaintVerdict();
    out.write('\n');
    writeBlank();
    writeSectionHeader('Evidence');
    for (const probe of state.trail) {
      if (probe.status === 'pending') continue;
      writeProbeRow(probe.ref, probe.status, probe.finding);
    }
    writeBlank();
    writeSectionHeader('Receipts');
    writeKv('Cost', `$${state.costUsd.toFixed(4)}`);
    if (state.paymentTx) writeKv('Payment TX', shortHash(state.paymentTx));
    if (state.reportUri) writeKv('Report', shortHash(state.reportUri));
    if (state.attestationRoot) writeKv('Attestation', shortHash(state.attestationRoot));
  });

  events.on('audit.failed', (step: TranscriptStep) => {
    const reason = (step.detail?.reason as string | undefined) ?? 'unknown failure';
    state = reduce(state, { type: 'audit.failed', reason });
    repaintVerdict();
    out.write(`\n\n${C_DIM}  ${reason}${C_RESET}\n`);
  });

  events.on('audit.report.pin', (step: TranscriptStep) => {
    const uri = (step.detail?.uri as string | undefined) ?? '';
    const hash = (step.detail?.hash as string | undefined) ?? '';
    if (!uri && !hash) return;
    state = reduce(state, { type: 'audit.report.pin', uri, hash });
  });

  events.on('audit.receipt.post', (step: TranscriptStep) => {
    const txHash = (step.detail?.txHash as string | undefined) ?? '';
    if (!txHash) return;
    state = reduce(state, { type: 'audit.receipt.post', txHash });
    // Fires AFTER audit.complete — append it to the receipts block.
    if (state.phase === 'complete') {
      writeKv('Receipt TX', shortHash(txHash));
    }
  });

  events.on('oracle.payment.settle', (step: TranscriptStep) => {
    const txHash = (step.detail?.txHash as string | undefined) ?? '';
    if (!txHash) return;
    state = reduce(state, { type: 'oracle.payment.settle', txHash });
  });

  // SIGINT — restore the cursor color and exit cleanly.
  const onSigint = () => {
    out.write(`\n${C_RESET}`);
    process.exit(130);
  };
  process.on('SIGINT', onSigint);

  // Header — one dim line above the morph so the operator sees the
  // target before any probes fire. No "INTENT" / "FLOW" / borders.
  out.write(`\n${C_DIM}  ${opts.target}${C_RESET}\n\n`);

  let exitCode = 0;
  try {
    await runCrossAgentDemo(wrappedDeps, {
      target: {
        agentId: 7n,
        agentName: opts.target,
        manifest: `placeholder manifest for ${opts.target}`,
      },
      oracleTopic: 'eu-ai-act',
      auditOptions: {
        apiKey: bundle.auditOptions.apiKey,
        registryAddress: bundle.auditOptions.registryAddress,
        agentRegistryCaip: bundle.auditOptions.agentRegistryCaip,
        clientAddress: bundle.auditOptions.clientAddress,
        now: bundle.auditOptions.now ?? new Date().toISOString(),
        quorum: bundle.auditOptions.quorum ?? 'majority',
      },
      events,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    state = reduce(state, { type: 'audit.failed', reason });
    repaintVerdict();
    out.write(`\n\n${C_DIM}  ${reason}${C_RESET}\n`);
    exitCode = 1;
  }

  out.write('\n');
  process.removeListener('SIGINT', onSigint);
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
