import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { evaluate, type PolicyViolation } from './policy.js';
import { scoreAgreement } from './consensus.js';
import type { InferenceAdapter } from './adapters/types.js';
import type { ProviderPool } from './pool.js';
import type {
  Adapter,
  InferenceIntent,
  InferenceResult,
  Mode,
  Provider,
  RouteResult,
} from './intent.js';
import type { ExecutionScope } from './scope.js';
import type { Result } from './result.js';
import type { KeeperClient } from './keeper.js';
import type { AuditWriter } from './audit.js';
import { ZG_GALILEO_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID } from './constants.js';

export const CONSENSUS_PROVIDER_COUNT = 3;
// Minimum participants for "consensus" to mean anything. With 3 providers,
// a 2/3 quorum is the lowest meaningful agreement. A single-provider result
// is not consensus — it's a single-provider call masquerading as one.
export const CONSENSUS_MIN_QUORUM = 2;
export const CONSENSUS_SYNTHETIC_PROVIDER_ID = 'consensus';
export const UNKNOWN_AGENT_INFT_ID = 'unknown';

export type RouteError =
  | { kind: 'policy'; violations: PolicyViolation[] }
  | { kind: 'no_provider'; reason: string }
  | { kind: 'inference_failed'; reason: string }
  | { kind: 'no_consensus'; reason: string }
  | { kind: 'attestation_required'; reason: string }
  | { kind: 'settlement_failed'; reason: string };

export interface RouterEvents {
  'route.start': { intent: InferenceIntent; scope: ExecutionScope };
  'route.policy_passed': { intent: InferenceIntent };
  'route.policy_failed': { violations: PolicyViolation[] };
  'route.providers_selected': { providers: readonly Provider[] };
  'route.inference_start': { provider: Provider; mode: Mode };
  'route.inference_complete': { provider: Provider; result: InferenceResult };
  'route.inference_failed': { provider: Provider; reason: string };
  'route.settlement_start': { provider: Provider; receipt: string };
  'route.settlement_complete': { provider: Provider; txHash: string };
  'route.settlement_failed': { provider: Provider; reason: string };
  'route.consensus_scored': {
    agreement_score: number;
    outliers: string[];
    low_confidence: boolean;
  };
  'route.audit_enqueued': { mode: Mode };
  'route.audit_flushed': { audit_cid: string };
  'route.complete': { result: RouteResult };
  'route.error': { error: RouteError };
}

export class RouterEventBus extends EventEmitter {
  override emit<K extends keyof RouterEvents>(event: K, payload: RouterEvents[K]): boolean {
    return super.emit(event as string, payload);
  }
  override on<K extends keyof RouterEvents>(
    event: K,
    listener: (payload: RouterEvents[K]) => void,
  ): this {
    return super.on(event as string, listener);
  }
  override once<K extends keyof RouterEvents>(
    event: K,
    listener: (payload: RouterEvents[K]) => void,
  ): this {
    return super.once(event as string, listener);
  }
  override off<K extends keyof RouterEvents>(
    event: K,
    listener: (payload: RouterEvents[K]) => void,
  ): this {
    return super.off(event as string, listener);
  }
}

export interface RouterOptions {
  pool: ProviderPool;
  adapters: ReadonlyMap<Adapter, InferenceAdapter>;
  events?: RouterEventBus;
  /** If absent, settlement step is skipped (development fast-path). */
  keeper?: KeeperClient;
  /** If absent, audit logging is skipped (development fast-path). */
  audit?: AuditWriter;
  /** iNFT token id for audit attribution. Defaults to UNKNOWN_AGENT_INFT_ID. */
  agentInftId?: string;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export interface Router {
  route(
    intent: InferenceIntent,
    scope: ExecutionScope,
  ): Promise<Result<RouteResult, RouteError>>;
  readonly events: RouterEventBus;
}

function pickAdapter(
  provider: Provider,
  adapters: ReadonlyMap<Adapter, InferenceAdapter>,
): InferenceAdapter | undefined {
  return adapters.get(provider.adapter);
}

function adapterChainId(adapter: Adapter): number {
  return adapter === 'zg' ? ZG_GALILEO_CHAIN_ID : BASE_SEPOLIA_CHAIN_ID;
}

function emitError(
  events: RouterEventBus,
  error: RouteError,
): { ok: false; error: RouteError } {
  events.emit('route.error', { error });
  return { ok: false, error };
}

interface SettledInference {
  result: InferenceResult;
  /** KeeperHub txHash, or null if keeper was not configured. */
  keeperTx: string | null;
}

/**
 * Tagged error so callers can map phases to RouteError kinds without
 * string-matching. Inference failures → 'inference_failed'; keeper failures
 * (any KeeperError kind) → 'settlement_failed'.
 */
type InferAndSettleError =
  | { phase: 'inference'; reason: string }
  | { phase: 'settlement'; reason: string };

async function runSingleProvider(
  provider: Provider,
  prompt: string,
  mode: Mode,
  adapters: ReadonlyMap<Adapter, InferenceAdapter>,
  events: RouterEventBus,
): Promise<Result<InferenceResult, string>> {
  const adapter = pickAdapter(provider, adapters);
  if (!adapter) {
    const reason = `no adapter registered for '${provider.adapter}'`;
    events.emit('route.inference_failed', { provider, reason });
    return { ok: false, error: reason };
  }
  events.emit('route.inference_start', { provider, mode });
  const result = await adapter.infer(provider, prompt);
  if (!result.ok) {
    const reason = `${result.error.kind}: ${result.error.reason}`;
    events.emit('route.inference_failed', { provider, reason });
    return { ok: false, error: reason };
  }
  events.emit('route.inference_complete', { provider, result: result.value });
  return { ok: true, value: result.value };
}

async function settleInference(
  provider: Provider,
  inference: InferenceResult,
  keeper: KeeperClient | undefined,
  events: RouterEventBus,
): Promise<Result<SettledInference, string>> {
  if (!keeper) {
    return { ok: true, value: { result: inference, keeperTx: null } };
  }
  events.emit('route.settlement_start', { provider, receipt: inference.receipt });
  const settled = await keeper.settle({
    tx: inference.receipt,
    chain: adapterChainId(provider.adapter),
  });
  if (!settled.ok) {
    // Surface every KeeperError kind (settlement_failed, transport, malformed_response,
    // unavailable) as a settlement failure. The router maps phase, not text.
    const reason = `${settled.error.kind}: ${settled.error.reason}`;
    events.emit('route.settlement_failed', { provider, reason });
    return { ok: false, error: reason };
  }
  events.emit('route.settlement_complete', {
    provider,
    txHash: settled.value.txHash,
  });
  return { ok: true, value: { result: inference, keeperTx: settled.value.txHash } };
}

async function inferAndSettle(
  provider: Provider,
  prompt: string,
  mode: Mode,
  adapters: ReadonlyMap<Adapter, InferenceAdapter>,
  keeper: KeeperClient | undefined,
  events: RouterEventBus,
): Promise<Result<SettledInference, InferAndSettleError>> {
  const inferred = await runSingleProvider(provider, prompt, mode, adapters, events);
  if (!inferred.ok) {
    return { ok: false, error: { phase: 'inference', reason: inferred.error } };
  }
  const settled = await settleInference(provider, inferred.value, keeper, events);
  if (!settled.ok) {
    return { ok: false, error: { phase: 'settlement', reason: settled.error } };
  }
  return { ok: true, value: settled.value };
}

function mapPhaseError(error: InferAndSettleError): RouteError {
  if (error.phase === 'settlement') {
    return { kind: 'settlement_failed', reason: error.reason };
  }
  return { kind: 'inference_failed', reason: error.reason };
}

interface AuditContext {
  mode: Mode;
  prompt: string;
  response: string;
  cost_usd: number;
  latency_ms: number;
  agreement_score: number | null;
  attestation_root: string | null;
  providers: string[];
  keeperhub_txs: string[];
  low_confidence: boolean;
}

function enqueueAuditAndAttachCid(
  audit: AuditWriter | undefined,
  agentInftId: string,
  ctx: AuditContext,
  events: RouterEventBus,
  attach: (cid: string) => void,
): void {
  if (!audit) return;
  audit.enqueue({
    agent_inft: agentInftId,
    mode: ctx.mode,
    providers: ctx.providers,
    prompt: ctx.prompt,
    response: ctx.response,
    cost_usd: ctx.cost_usd,
    latency_ms: ctx.latency_ms,
    agreement_score: ctx.agreement_score,
    attestation_root: ctx.attestation_root,
    keeperhub_txs: ctx.keeperhub_txs,
    low_confidence: ctx.low_confidence,
    onFlushed: (cid) => {
      attach(cid);
      events.emit('route.audit_flushed', { audit_cid: cid });
    },
  });
  events.emit('route.audit_enqueued', { mode: ctx.mode });
}

async function runFast(
  intent: InferenceIntent,
  pool: ProviderPool,
  adapters: ReadonlyMap<Adapter, InferenceAdapter>,
  keeper: KeeperClient | undefined,
  audit: AuditWriter | undefined,
  agentInftId: string,
  events: RouterEventBus,
): Promise<Result<RouteResult, RouteError>> {
  const providers = await pool.query({
    teeRequired: false,
    maxCostUsd: intent.max_cost_usd,
    maxLatencyMs: intent.max_latency_ms,
    count: 1,
  });
  events.emit('route.providers_selected', { providers });
  if (providers.length === 0) {
    return emitError(events, {
      kind: 'no_provider',
      reason: 'no provider available within cost/latency limits',
    });
  }
  const settled = await inferAndSettle(
    providers[0]!,
    intent.prompt,
    'fast',
    adapters,
    keeper,
    events,
  );
  if (!settled.ok) {
    return emitError(events, mapPhaseError(settled.error));
  }
  const { result, keeperTx } = settled.value;
  const keeperhub_txs = keeperTx === null ? [] : [keeperTx];
  const route: RouteResult = {
    response: result.response,
    cost_usd: result.cost_usd,
    latency_ms: result.latency_ms,
    attestation_root: result.attestation_root,
    provider_id: result.provider_id,
    receipt: result.receipt,
    provider_ids: [result.provider_id],
    receipts: [result.receipt],
    mode: 'fast',
    agreement_score: null,
    outliers: [],
    low_confidence: false,
    audit_cid: null,
  };
  enqueueAuditAndAttachCid(
    audit,
    agentInftId,
    {
      mode: 'fast',
      prompt: intent.prompt,
      response: result.response,
      cost_usd: result.cost_usd,
      latency_ms: result.latency_ms,
      agreement_score: null,
      attestation_root: result.attestation_root,
      providers: [result.provider_id],
      keeperhub_txs,
      low_confidence: false,
    },
    events,
    (cid) => {
      route.audit_cid = cid;
    },
  );
  events.emit('route.complete', { result: route });
  return { ok: true, value: route };
}

async function runVerified(
  intent: InferenceIntent,
  pool: ProviderPool,
  adapters: ReadonlyMap<Adapter, InferenceAdapter>,
  keeper: KeeperClient | undefined,
  audit: AuditWriter | undefined,
  agentInftId: string,
  events: RouterEventBus,
): Promise<Result<RouteResult, RouteError>> {
  const providers = await pool.query({
    teeRequired: true,
    maxCostUsd: intent.max_cost_usd,
    maxLatencyMs: intent.max_latency_ms,
    count: 1,
  });
  events.emit('route.providers_selected', { providers });
  if (providers.length === 0) {
    return emitError(events, {
      kind: 'no_provider',
      reason: 'no TEE provider available within cost/latency limits',
    });
  }
  const settled = await inferAndSettle(
    providers[0]!,
    intent.prompt,
    'verified',
    adapters,
    keeper,
    events,
  );
  if (!settled.ok) {
    return emitError(events, mapPhaseError(settled.error));
  }
  const { result, keeperTx } = settled.value;
  if (result.attestation_root === null) {
    return emitError(events, {
      kind: 'attestation_required',
      reason: `verified mode received null attestation_root from ${result.provider_id}`,
    });
  }
  const keeperhub_txs = keeperTx === null ? [] : [keeperTx];
  const route: RouteResult = {
    response: result.response,
    cost_usd: result.cost_usd,
    latency_ms: result.latency_ms,
    attestation_root: result.attestation_root,
    provider_id: result.provider_id,
    receipt: result.receipt,
    provider_ids: [result.provider_id],
    receipts: [result.receipt],
    mode: 'verified',
    agreement_score: null,
    outliers: [],
    low_confidence: false,
    audit_cid: null,
  };
  enqueueAuditAndAttachCid(
    audit,
    agentInftId,
    {
      mode: 'verified',
      prompt: intent.prompt,
      response: result.response,
      cost_usd: result.cost_usd,
      latency_ms: result.latency_ms,
      agreement_score: null,
      attestation_root: result.attestation_root,
      providers: [result.provider_id],
      keeperhub_txs,
      low_confidence: false,
    },
    events,
    (cid) => {
      route.audit_cid = cid;
    },
  );
  events.emit('route.complete', { result: route });
  return { ok: true, value: route };
}

async function runConsensus(
  intent: InferenceIntent,
  pool: ProviderPool,
  adapters: ReadonlyMap<Adapter, InferenceAdapter>,
  keeper: KeeperClient | undefined,
  audit: AuditWriter | undefined,
  agentInftId: string,
  events: RouterEventBus,
): Promise<Result<RouteResult, RouteError>> {
  const perCallBudget = intent.max_cost_usd / CONSENSUS_PROVIDER_COUNT;
  const providers = await pool.query({
    teeRequired: false,
    maxCostUsd: perCallBudget,
    maxLatencyMs: intent.max_latency_ms,
    count: CONSENSUS_PROVIDER_COUNT,
    requireOneTee: true,
  });
  events.emit('route.providers_selected', { providers });
  if (providers.length === 0) {
    return emitError(events, {
      kind: 'no_provider',
      reason: 'no providers available for consensus within per-call budget',
    });
  }

  const settled = await Promise.all(
    providers.map((p) => inferAndSettle(p, intent.prompt, 'consensus', adapters, keeper, events)),
  );
  const successes = settled.filter((r): r is { ok: true; value: SettledInference } => r.ok);
  if (successes.length < CONSENSUS_MIN_QUORUM) {
    return emitError(events, {
      kind: 'no_consensus',
      reason: `consensus needs at least ${CONSENSUS_MIN_QUORUM} successful providers, got ${successes.length}`,
    });
  }

  const inferenceResults = successes.map((r) => r.value.result);
  const score = scoreAgreement(inferenceResults, intent.output_type);

  events.emit('route.consensus_scored', {
    agreement_score: score.agreement_score,
    outliers: score.outliers,
    low_confidence: score.low_confidence,
  });

  const anchor = inferenceResults.find((r) => r.response === score.consensus_response);
  const totalCost = inferenceResults.reduce((sum, r) => sum + r.cost_usd, 0);
  const maxLatency = inferenceResults.reduce((m, r) => Math.max(m, r.latency_ms), 0);
  const attestationRoot = inferenceResults
    .map((r) => r.attestation_root)
    .find((root): root is string => typeof root === 'string') ?? null;
  if (attestationRoot === null) {
    return emitError(events, {
      kind: 'attestation_required',
      reason: 'consensus produced no TEE attestation across participating providers',
    });
  }

  const keeperhub_txs = successes
    .map((s) => s.value.keeperTx)
    .filter((tx): tx is string => typeof tx === 'string');

  const route: RouteResult = {
    response: score.consensus_response,
    cost_usd: totalCost,
    latency_ms: maxLatency,
    attestation_root: attestationRoot,
    provider_id: anchor?.provider_id ?? CONSENSUS_SYNTHETIC_PROVIDER_ID,
    receipt: anchor?.receipt ?? CONSENSUS_SYNTHETIC_PROVIDER_ID,
    provider_ids: inferenceResults.map((r) => r.provider_id),
    receipts: inferenceResults.map((r) => r.receipt),
    mode: 'consensus',
    agreement_score: score.agreement_score,
    outliers: score.outliers,
    low_confidence: score.low_confidence,
    audit_cid: null,
  };
  enqueueAuditAndAttachCid(
    audit,
    agentInftId,
    {
      mode: 'consensus',
      prompt: intent.prompt,
      response: score.consensus_response,
      cost_usd: totalCost,
      latency_ms: maxLatency,
      agreement_score: score.agreement_score,
      attestation_root: attestationRoot,
      providers: inferenceResults.map((r) => r.provider_id),
      keeperhub_txs,
      low_confidence: score.low_confidence,
    },
    events,
    (cid) => {
      route.audit_cid = cid;
    },
  );
  events.emit('route.complete', { result: route });
  return { ok: true, value: route };
}

async function runPipeline(
  intent: InferenceIntent,
  pool: ProviderPool,
  adapters: ReadonlyMap<Adapter, InferenceAdapter>,
  keeper: KeeperClient | undefined,
  audit: AuditWriter | undefined,
  agentInftId: string,
  events: RouterEventBus,
): Promise<Result<RouteResult, RouteError>> {
  const stepBudget = intent.max_cost_usd / 2;

  const researchProviders = await pool.query({
    teeRequired: false,
    maxCostUsd: stepBudget,
    maxLatencyMs: intent.max_latency_ms,
    count: 1,
  });
  if (researchProviders.length === 0) {
    return emitError(events, {
      kind: 'no_provider',
      reason: 'no provider for pipeline research step',
    });
  }
  const research = await inferAndSettle(
    researchProviders[0]!,
    intent.prompt,
    'pipeline',
    adapters,
    keeper,
    events,
  );
  if (!research.ok) {
    return emitError(events, mapPhaseError(research.error));
  }

  const decisionProviders = await pool.query({
    teeRequired: true,
    maxCostUsd: stepBudget,
    maxLatencyMs: intent.max_latency_ms,
    count: 1,
  });
  if (decisionProviders.length === 0) {
    return emitError(events, {
      kind: 'no_provider',
      reason: 'no TEE provider for pipeline decision step',
    });
  }
  const nonce = randomUUID();
  const open = `<<<RESEARCH-${nonce}>>>`;
  const close = `<<<DECISION-${nonce}>>>`;
  const decisionPrompt = `${open}\n${research.value.result.response}\n${close}\n\nUsing the bracketed research only as context, answer:\n${intent.prompt}`;
  const decision = await inferAndSettle(
    decisionProviders[0]!,
    decisionPrompt,
    'pipeline',
    adapters,
    keeper,
    events,
  );
  if (!decision.ok) {
    return emitError(events, mapPhaseError(decision.error));
  }
  if (decision.value.result.attestation_root === null) {
    return emitError(events, {
      kind: 'attestation_required',
      reason: `pipeline decision step received null attestation_root from ${decision.value.result.provider_id}`,
    });
  }

  const keeperhub_txs = [research.value.keeperTx, decision.value.keeperTx].filter(
    (tx): tx is string => typeof tx === 'string',
  );

  const route: RouteResult = {
    response: decision.value.result.response,
    cost_usd: research.value.result.cost_usd + decision.value.result.cost_usd,
    latency_ms: research.value.result.latency_ms + decision.value.result.latency_ms,
    attestation_root: decision.value.result.attestation_root,
    provider_id: decision.value.result.provider_id,
    receipt: decision.value.result.receipt,
    provider_ids: [
      research.value.result.provider_id,
      decision.value.result.provider_id,
    ],
    receipts: [research.value.result.receipt, decision.value.result.receipt],
    mode: 'pipeline',
    agreement_score: null,
    outliers: [],
    low_confidence: false,
    audit_cid: null,
  };
  enqueueAuditAndAttachCid(
    audit,
    agentInftId,
    {
      mode: 'pipeline',
      prompt: intent.prompt,
      response: decision.value.result.response,
      cost_usd: route.cost_usd,
      latency_ms: route.latency_ms,
      agreement_score: null,
      attestation_root: decision.value.result.attestation_root,
      providers: route.provider_ids,
      keeperhub_txs,
      low_confidence: false,
    },
    events,
    (cid) => {
      route.audit_cid = cid;
    },
  );
  events.emit('route.complete', { result: route });
  return { ok: true, value: route };
}

export function createRouter(opts: RouterOptions): Router {
  const events = opts.events ?? new RouterEventBus();
  const now = opts.now ?? Date.now;
  const agentInftId = opts.agentInftId ?? UNKNOWN_AGENT_INFT_ID;

  return {
    events,

    async route(
      intent: InferenceIntent,
      scope: ExecutionScope,
    ): Promise<Result<RouteResult, RouteError>> {
      events.emit('route.start', { intent, scope });

      const policy = evaluate(intent, scope, now());
      if (!policy.allowed) {
        events.emit('route.policy_failed', { violations: policy.violations });
        return emitError(events, { kind: 'policy', violations: policy.violations });
      }
      events.emit('route.policy_passed', { intent });

      switch (intent.mode) {
        case 'fast':
          return runFast(intent, opts.pool, opts.adapters, opts.keeper, opts.audit, agentInftId, events);
        case 'verified':
          return runVerified(intent, opts.pool, opts.adapters, opts.keeper, opts.audit, agentInftId, events);
        case 'consensus':
          return runConsensus(intent, opts.pool, opts.adapters, opts.keeper, opts.audit, agentInftId, events);
        case 'pipeline':
          return runPipeline(intent, opts.pool, opts.adapters, opts.keeper, opts.audit, agentInftId, events);
      }
    },
  };
}
