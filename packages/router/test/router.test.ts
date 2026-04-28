import { describe, it, expect } from 'bun:test';
import {
  createRouter,
  RouterEventBus,
  CONSENSUS_PROVIDER_COUNT,
  CONSENSUS_SYNTHETIC_PROVIDER_ID,
} from '../src/router.js';
import { createPool } from '../src/pool.js';
import type { InferenceAdapter } from '../src/adapters/types.js';
import type {
  Adapter,
  InferenceIntent,
  InferenceResult,
  Provider,
  RouteResult,
} from '../src/intent.js';
import type { ExecutionScope } from '../src/scope.js';

function makeIntent(overrides: Partial<InferenceIntent> = {}): InferenceIntent {
  return {
    prompt: 'classify this',
    mode: 'fast',
    max_cost_usd: 0.01,
    max_latency_ms: 5_000,
    output_type: 'freeform',
    ...overrides,
  };
}

function makeScope(overrides: Partial<ExecutionScope> = {}): ExecutionScope {
  return {
    allowedModes: ['fast', 'verified', 'consensus', 'pipeline'],
    maxCostUsd: 0.1,
    maxLatencyMs: 10_000,
    ttlMs: 60_000,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

interface AdapterStubOptions {
  id: 'zg' | 'x402';
  tee: boolean;
  providers: Provider[];
  inferReturns?: (provider: Provider, prompt: string) => InferenceResult;
  inferFails?: (provider: Provider) => boolean;
}

function makeAdapter(opts: AdapterStubOptions): InferenceAdapter {
  return {
    id: opts.id,
    capabilities: { tee: opts.tee },
    async listProviders(): Promise<Provider[]> {
      return opts.providers;
    },
    async infer(provider: Provider, prompt: string) {
      if (opts.inferFails?.(provider)) {
        return { ok: false as const, error: { kind: 'transport' as const, reason: 'simulated failure' } };
      }
      const result = opts.inferReturns
        ? opts.inferReturns(provider, prompt)
        : {
            response: `${provider.id}-response`,
            cost_usd: provider.price_per_call_usd,
            latency_ms: provider.latency_p50_ms,
            attestation_root: opts.tee ? `att-${provider.id}` : null,
            receipt: `rcpt-${provider.id}`,
            provider_id: provider.id,
          };
      return { ok: true as const, value: result };
    },
  };
}

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'x402:default',
    model: 'm',
    tee: false,
    price_per_call_usd: 0.0001,
    latency_p50_ms: 300,
    adapter: 'x402',
    ...overrides,
  };
}

function adapterMap(adapters: InferenceAdapter[]): ReadonlyMap<Adapter, InferenceAdapter> {
  const m = new Map<Adapter, InferenceAdapter>();
  for (const a of adapters) m.set(a.id, a);
  return m;
}

function expectAuditArrays(result: RouteResult, expectedLen: number): void {
  expect(result.provider_ids).toHaveLength(expectedLen);
  expect(result.receipts).toHaveLength(expectedLen);
  expect(result.audit_cid).toBeNull();
}

describe('router — policy gate', () => {
  it('rejects intent that exceeds scope spend cap', async () => {
    const adapter = makeAdapter({ id: 'x402', tee: false, providers: [makeProvider()] });
    const router = createRouter({ pool: createPool([adapter]), adapters: adapterMap([adapter]) });
    const result = await router.route(
      makeIntent({ max_cost_usd: 1 }),
      makeScope({ maxCostUsd: 0.01 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'policy') {
      expect(result.error.violations.some((v) => v.rule === 'spend_cap')).toBe(true);
    }
  });

  it('rejects intent for disallowed mode', async () => {
    const adapter = makeAdapter({ id: 'x402', tee: false, providers: [makeProvider()] });
    const router = createRouter({ pool: createPool([adapter]), adapters: adapterMap([adapter]) });
    const result = await router.route(
      makeIntent({ mode: 'consensus' }),
      makeScope({ allowedModes: ['fast'] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'policy') {
      expect(result.error.violations.some((v) => v.rule === 'mode_allowed')).toBe(true);
    }
  });

  it('rejects expired scope', async () => {
    const adapter = makeAdapter({ id: 'x402', tee: false, providers: [makeProvider()] });
    const router = createRouter({
      pool: createPool([adapter]),
      adapters: adapterMap([adapter]),
      now: () => 10_000_000,
    });
    const result = await router.route(makeIntent(), makeScope({ expiresAt: 5_000_000 }));
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'policy') {
      expect(result.error.violations.some((v) => v.rule === 'not_expired')).toBe(true);
    }
  });
});

describe('router — fast mode', () => {
  it('returns route result from cheapest provider with audit array length 1', async () => {
    const cheap = makeProvider({ id: 'x402:cheap', price_per_call_usd: 0.0001 });
    const expensive = makeProvider({ id: 'x402:expensive', price_per_call_usd: 0.001 });
    const adapter = makeAdapter({ id: 'x402', tee: false, providers: [expensive, cheap] });
    const router = createRouter({ pool: createPool([adapter]), adapters: adapterMap([adapter]) });
    const result = await router.route(makeIntent({ mode: 'fast' }), makeScope());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mode).toBe('fast');
      expect(result.value.provider_id).toBe('x402:cheap');
      expect(result.value.agreement_score).toBeNull();
      expectAuditArrays(result.value, 1);
      expect(result.value.provider_ids).toEqual(['x402:cheap']);
      expect(result.value.receipts).toEqual(['rcpt-x402:cheap']);
    }
  });

  it('returns no_provider when pool empty', async () => {
    const adapter = makeAdapter({ id: 'x402', tee: false, providers: [] });
    const router = createRouter({ pool: createPool([adapter]), adapters: adapterMap([adapter]) });
    const result = await router.route(makeIntent({ mode: 'fast' }), makeScope());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('no_provider');
  });

  it('returns inference_failed when adapter fails', async () => {
    const provider = makeProvider();
    const adapter = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [provider],
      inferFails: () => true,
    });
    const router = createRouter({ pool: createPool([adapter]), adapters: adapterMap([adapter]) });
    const result = await router.route(makeIntent({ mode: 'fast' }), makeScope());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('inference_failed');
  });

  it('returns inference_failed when provider adapter is not in adapter map', async () => {
    // Provider says adapter='zg' but the router only has x402 in the adapter map.
    const orphanProvider: Provider = {
      ...makeProvider(),
      id: 'zg:orphan',
      adapter: 'zg',
      tee: true,
    };
    // Pool sees it via a stub x402 adapter that lies (returns a zg-tagged provider).
    const lyingAdapter = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [orphanProvider],
    });
    const router = createRouter({
      pool: createPool([lyingAdapter]),
      adapters: adapterMap([lyingAdapter]),
    });
    const result = await router.route(makeIntent({ mode: 'fast' }), makeScope());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('inference_failed');
      if (result.error.kind === 'inference_failed') {
        expect(result.error.reason).toContain('zg');
      }
    }
  });
});

describe('router — verified mode', () => {
  it('routes to TEE provider only', async () => {
    const cheapNonTee = makeProvider({ id: 'x402:cheap', price_per_call_usd: 0.0001 });
    const teeProvider = makeProvider({
      id: 'zg:0xa',
      tee: true,
      adapter: 'zg',
      price_per_call_usd: 0.0005,
    });
    const x402 = makeAdapter({ id: 'x402', tee: false, providers: [cheapNonTee] });
    const zg = makeAdapter({ id: 'zg', tee: true, providers: [teeProvider] });
    const router = createRouter({
      pool: createPool([x402, zg]),
      adapters: adapterMap([x402, zg]),
    });
    const result = await router.route(makeIntent({ mode: 'verified' }), makeScope());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mode).toBe('verified');
      expect(result.value.provider_id).toBe('zg:0xa');
      expect(result.value.attestation_root).toBe('att-zg:0xa');
      expectAuditArrays(result.value, 1);
    }
  });

  it('returns no_provider when no TEE adapter has providers', async () => {
    const x402 = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [makeProvider()],
    });
    const router = createRouter({ pool: createPool([x402]), adapters: adapterMap([x402]) });
    const result = await router.route(makeIntent({ mode: 'verified' }), makeScope());
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'no_provider') {
      expect(result.error.reason).toContain('TEE');
    }
  });

  it('fails closed (attestation_required) when TEE provider returns null attestation', async () => {
    const teeProvider = makeProvider({
      id: 'zg:broken',
      tee: true,
      adapter: 'zg',
    });
    const zg = makeAdapter({
      id: 'zg',
      tee: true,
      providers: [teeProvider],
      inferReturns: (p) => ({
        response: 'r',
        cost_usd: 0.0001,
        latency_ms: 100,
        attestation_root: null, // simulating Phase-1-style null
        receipt: 'rcpt',
        provider_id: p.id,
      }),
    });
    const router = createRouter({ pool: createPool([zg]), adapters: adapterMap([zg]) });
    const result = await router.route(makeIntent({ mode: 'verified' }), makeScope());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('attestation_required');
  });
});

describe('router — consensus mode', () => {
  function buildConsensusFleet(responses: Record<string, string>) {
    const x402Providers = [
      makeProvider({ id: 'x402:p1', price_per_call_usd: 0.0001 }),
      makeProvider({ id: 'x402:p2', price_per_call_usd: 0.0001 }),
    ];
    const teeProvider = makeProvider({
      id: 'zg:t1',
      tee: true,
      adapter: 'zg',
      price_per_call_usd: 0.0001,
    });
    const x402 = makeAdapter({
      id: 'x402',
      tee: false,
      providers: x402Providers,
      inferReturns: (p) => ({
        response: responses[p.id]!,
        cost_usd: 0.0001,
        latency_ms: 200,
        attestation_root: null,
        receipt: `r-${p.id}`,
        provider_id: p.id,
      }),
    });
    const zg = makeAdapter({
      id: 'zg',
      tee: true,
      providers: [teeProvider],
      inferReturns: (p) => ({
        response: responses[p.id]!,
        cost_usd: 0.0001,
        latency_ms: 1500,
        attestation_root: 'tee-root',
        receipt: `r-${p.id}`,
        provider_id: p.id,
      }),
    });
    return { x402, zg };
  }

  it('runs N providers in parallel and scores agreement (3 audit entries)', async () => {
    const { x402, zg } = buildConsensusFleet({
      'x402:p1': 'bullish',
      'x402:p2': 'bullish',
      'zg:t1': 'bullish',
    });
    const router = createRouter({
      pool: createPool([x402, zg]),
      adapters: adapterMap([x402, zg]),
    });
    const result = await router.route(
      makeIntent({ mode: 'consensus', output_type: 'categorical', max_cost_usd: 0.001 }),
      makeScope(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mode).toBe('consensus');
      expect(result.value.response).toBe('bullish');
      expect(result.value.agreement_score).toBe(1);
      expect(result.value.attestation_root).toBe('tee-root');
      expectAuditArrays(result.value, CONSENSUS_PROVIDER_COUNT);
    }
  });

  it('uses synthetic provider_id when consensus_response does not match any single call', async () => {
    // Numeric mode: consensus_response = formatted mean. Will not match any individual response.
    const x402 = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [
        makeProvider({ id: 'x402:p1' }),
        makeProvider({ id: 'x402:p2' }),
      ],
      inferReturns: (p) => ({
        response: p.id === 'x402:p1' ? '100' : '110',
        cost_usd: 0.0001,
        latency_ms: 200,
        attestation_root: null,
        receipt: `r-${p.id}`,
        provider_id: p.id,
      }),
    });
    const zg = makeAdapter({
      id: 'zg',
      tee: true,
      providers: [makeProvider({ id: 'zg:t1', tee: true, adapter: 'zg' })],
      inferReturns: (p) => ({
        // Choose 105 so the mean (105) coincides with no individual response
        // when paired with 100 and 110 (mean is 105 but z-score makes one inlier
        // group of three with mean 105 — anchor.find returns nothing because
        // formatted mean "105" does not match "100" or "110"). Adjusted value
        // 130 ensures clear no-match across all three.
        response: '130',
        cost_usd: 0.0001,
        latency_ms: 1500,
        attestation_root: 'tee-root',
        receipt: `r-${p.id}`,
        provider_id: p.id,
      }),
    });
    const router = createRouter({
      pool: createPool([x402, zg]),
      adapters: adapterMap([x402, zg]),
    });
    const result = await router.route(
      makeIntent({ mode: 'consensus', output_type: 'numeric', max_cost_usd: 0.001 }),
      makeScope(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.provider_id).toBe(CONSENSUS_SYNTHETIC_PROVIDER_ID);
      expect(result.value.receipt).toBe(CONSENSUS_SYNTHETIC_PROVIDER_ID);
      expect(result.value.provider_ids).toEqual(['x402:p1', 'x402:p2', 'zg:t1']);
      expect(result.value.receipts).toEqual(['r-x402:p1', 'r-x402:p2', 'r-zg:t1']);
    }
  });

  it('returns no_consensus when every provider fails', async () => {
    const x402 = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [
        makeProvider({ id: 'x402:p1' }),
        makeProvider({ id: 'x402:p2' }),
      ],
      inferFails: () => true,
    });
    const zg = makeAdapter({
      id: 'zg',
      tee: true,
      providers: [makeProvider({ id: 'zg:t1', tee: true, adapter: 'zg' })],
      inferFails: () => true,
    });
    const router = createRouter({
      pool: createPool([x402, zg]),
      adapters: adapterMap([x402, zg]),
    });
    const result = await router.route(
      makeIntent({ mode: 'consensus', max_cost_usd: 0.001 }),
      makeScope(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('no_consensus');
  });

  it('fails closed when no TEE attestation present in consensus', async () => {
    // 3 non-TEE providers — pool will pass requireOneTee best-effort, no TEE found.
    const x402 = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [
        makeProvider({ id: 'x402:a' }),
        makeProvider({ id: 'x402:b' }),
        makeProvider({ id: 'x402:c' }),
      ],
    });
    const router = createRouter({
      pool: createPool([x402]),
      adapters: adapterMap([x402]),
    });
    const result = await router.route(
      makeIntent({ mode: 'consensus', max_cost_usd: 0.001 }),
      makeScope(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('attestation_required');
  });

  it('flags low_confidence on disagreement', async () => {
    const { x402, zg } = buildConsensusFleet({
      'x402:p1': 'bullish',
      'x402:p2': 'bearish',
      'zg:t1': 'neutral',
    });
    const router = createRouter({
      pool: createPool([x402, zg]),
      adapters: adapterMap([x402, zg]),
    });
    const result = await router.route(
      makeIntent({ mode: 'consensus', output_type: 'categorical', max_cost_usd: 0.001 }),
      makeScope(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.low_confidence).toBe(true);
      expect(result.value.outliers.length).toBeGreaterThan(0);
    }
  });

  it('requireOneTee swaps TEE into top-3 when cheaper non-TEE dominate', async () => {
    // 3 cheap non-TEE + 1 expensive TEE. Without requireOneTee top-3 would be all non-TEE.
    const x402 = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [
        makeProvider({ id: 'x402:a', price_per_call_usd: 0.00001 }),
        makeProvider({ id: 'x402:b', price_per_call_usd: 0.00002 }),
        makeProvider({ id: 'x402:c', price_per_call_usd: 0.00003 }),
      ],
    });
    const zg = makeAdapter({
      id: 'zg',
      tee: true,
      providers: [
        makeProvider({
          id: 'zg:t',
          tee: true,
          adapter: 'zg',
          price_per_call_usd: 0.0001,
        }),
      ],
    });
    const router = createRouter({
      pool: createPool([x402, zg]),
      adapters: adapterMap([x402, zg]),
    });
    const result = await router.route(
      makeIntent({ mode: 'consensus', max_cost_usd: 0.003 }),
      makeScope(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.provider_ids).toContain('zg:t');
    }
  });
});

describe('router — pipeline mode', () => {
  it('runs research then TEE-attested decision; aggregates cost and latency', async () => {
    const research = makeProvider({ id: 'x402:research' });
    const decision = makeProvider({ id: 'zg:decision', tee: true, adapter: 'zg' });
    let researchPromptSeen = '';
    let decisionPromptSeen = '';
    const x402 = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [research],
      inferReturns: (p, prompt) => {
        researchPromptSeen = prompt;
        return {
          response: 'tariffs are rising',
          cost_usd: 0.0001,
          latency_ms: 200,
          attestation_root: null,
          receipt: 'r1',
          provider_id: p.id,
        };
      },
    });
    const zg = makeAdapter({
      id: 'zg',
      tee: true,
      providers: [decision],
      inferReturns: (p, prompt) => {
        decisionPromptSeen = prompt;
        return {
          response: 'sell',
          cost_usd: 0.0003,
          latency_ms: 1500,
          attestation_root: 'tee-root-decision',
          receipt: 'r2',
          provider_id: p.id,
        };
      },
    });
    const router = createRouter({
      pool: createPool([x402, zg]),
      adapters: adapterMap([x402, zg]),
    });
    const result = await router.route(
      makeIntent({ mode: 'pipeline', prompt: 'should I sell?', max_cost_usd: 0.001 }),
      makeScope(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.response).toBe('sell');
      expect(result.value.attestation_root).toBe('tee-root-decision');
      expect(result.value.cost_usd).toBe(0.0001 + 0.0003);
      // Pipeline runs sequentially → latency is the sum.
      expect(result.value.latency_ms).toBe(200 + 1500);
      expect(result.value.provider_ids).toEqual(['x402:research', 'zg:decision']);
      expect(result.value.receipts).toEqual(['r1', 'r2']);
    }
    expect(researchPromptSeen).toBe('should I sell?');
    expect(decisionPromptSeen).toContain('RESEARCH-');
    expect(decisionPromptSeen).toContain('tariffs are rising');
    expect(decisionPromptSeen).toContain('should I sell?');
  });

  it('fails closed when decision step returns null attestation', async () => {
    const research = makeProvider({ id: 'x402:r' });
    const decision = makeProvider({ id: 'zg:d', tee: true, adapter: 'zg' });
    const x402 = makeAdapter({ id: 'x402', tee: false, providers: [research] });
    const zg = makeAdapter({
      id: 'zg',
      tee: true,
      providers: [decision],
      inferReturns: (p) => ({
        response: 'sell',
        cost_usd: 0.0003,
        latency_ms: 1500,
        attestation_root: null,
        receipt: 'rcpt',
        provider_id: p.id,
      }),
    });
    const router = createRouter({
      pool: createPool([x402, zg]),
      adapters: adapterMap([x402, zg]),
    });
    const result = await router.route(
      makeIntent({ mode: 'pipeline', max_cost_usd: 0.001 }),
      makeScope(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('attestation_required');
  });

  it('returns no_provider when no providers available at all', async () => {
    const x402 = makeAdapter({ id: 'x402', tee: false, providers: [] });
    const zg = makeAdapter({ id: 'zg', tee: true, providers: [] });
    const router = createRouter({
      pool: createPool([x402, zg]),
      adapters: adapterMap([x402, zg]),
    });
    const result = await router.route(
      makeIntent({ mode: 'pipeline', max_cost_usd: 0.001 }),
      makeScope(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('no_provider');
  });

  it('returns no_provider when no TEE provider for decision step', async () => {
    const research = makeProvider({ id: 'x402:r' });
    const x402 = makeAdapter({ id: 'x402', tee: false, providers: [research] });
    const zg = makeAdapter({ id: 'zg', tee: true, providers: [] });
    const router = createRouter({
      pool: createPool([x402, zg]),
      adapters: adapterMap([x402, zg]),
    });
    const result = await router.route(
      makeIntent({ mode: 'pipeline', max_cost_usd: 0.001 }),
      makeScope(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'no_provider') {
      expect(result.error.reason).toContain('decision');
    }
  });
});

describe('router — events', () => {
  it('emits route.start, route.policy_passed, route.complete on success', async () => {
    const adapter = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [makeProvider()],
    });
    const events = new RouterEventBus();
    const router = createRouter({
      pool: createPool([adapter]),
      adapters: adapterMap([adapter]),
      events,
    });
    const seen: string[] = [];
    events.on('route.start', () => seen.push('start'));
    events.on('route.policy_passed', () => seen.push('policy_passed'));
    events.on('route.providers_selected', () => seen.push('providers_selected'));
    events.on('route.inference_start', () => seen.push('inference_start'));
    events.on('route.inference_complete', () => seen.push('inference_complete'));
    events.on('route.complete', () => seen.push('complete'));
    await router.route(makeIntent(), makeScope());
    expect(seen).toEqual([
      'start',
      'policy_passed',
      'providers_selected',
      'inference_start',
      'inference_complete',
      'complete',
    ]);
  });

  it('emits typed payloads with expected fields', async () => {
    const adapter = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [makeProvider({ id: 'x402:typed', price_per_call_usd: 0.00009 })],
    });
    const events = new RouterEventBus();
    const router = createRouter({
      pool: createPool([adapter]),
      adapters: adapterMap([adapter]),
      events,
    });
    let providersSeen: readonly Provider[] | null = null;
    let inferenceCompleteResult: InferenceResult | null = null;
    events.on('route.providers_selected', (p) => {
      providersSeen = p.providers;
    });
    events.on('route.inference_complete', (p) => {
      inferenceCompleteResult = p.result;
    });
    await router.route(makeIntent(), makeScope());
    expect(providersSeen).not.toBeNull();
    expect(providersSeen!).toHaveLength(1);
    expect(providersSeen![0]!.id).toBe('x402:typed');
    expect(inferenceCompleteResult).not.toBeNull();
    expect(inferenceCompleteResult!.provider_id).toBe('x402:typed');
  });

  it('emits route.policy_failed and route.error on policy violation', async () => {
    const adapter = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [makeProvider()],
    });
    const events = new RouterEventBus();
    const router = createRouter({
      pool: createPool([adapter]),
      adapters: adapterMap([adapter]),
      events,
    });
    let policyFailed = false;
    let errored = false;
    events.on('route.policy_failed', () => {
      policyFailed = true;
    });
    events.on('route.error', () => {
      errored = true;
    });
    await router.route(makeIntent({ max_cost_usd: 1 }), makeScope({ maxCostUsd: 0.001 }));
    expect(policyFailed).toBe(true);
    expect(errored).toBe(true);
  });

  it('emits route.consensus_scored in consensus mode', async () => {
    const providers = [
      makeProvider({ id: 'x402:a' }),
      makeProvider({ id: 'x402:b' }),
      makeProvider({ id: 'zg:t', tee: true, adapter: 'zg' }),
    ];
    const x402 = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [providers[0]!, providers[1]!],
    });
    const zg = makeAdapter({
      id: 'zg',
      tee: true,
      providers: [providers[2]!],
    });
    const events = new RouterEventBus();
    const router = createRouter({
      pool: createPool([x402, zg]),
      adapters: adapterMap([x402, zg]),
      events,
    });
    let scoreSeen: number | null = null;
    events.on('route.consensus_scored', ({ agreement_score }) => {
      scoreSeen = agreement_score;
    });
    await router.route(
      makeIntent({ mode: 'consensus', max_cost_usd: 0.001 }),
      makeScope(),
    );
    expect(scoreSeen).not.toBeNull();
  });
});

import type { KeeperClient, SettleParams } from '../src/keeper.js';
import { createAuditWriter, type AuditEvent, type AuditStorageBackend } from '../src/audit.js';

interface StubKeeperOptions {
  fail?: boolean;
  txHashOf?: (params: SettleParams) => string;
}

function makeKeeper(opts: StubKeeperOptions = {}): KeeperClient & { calls: SettleParams[] } {
  const calls: SettleParams[] = [];
  const client: KeeperClient = {
    async settle(params: SettleParams) {
      calls.push(params);
      if (opts.fail) {
        return {
          ok: false,
          error: { kind: 'settlement_failed' as const, reason: 'simulated' },
        };
      }
      const txHash = opts.txHashOf?.(params) ?? `0xkeeper-${calls.length}`;
      return { ok: true, value: { txHash, confirmed: true } };
    },
    async close() {
      /* noop */
    },
  };
  return Object.assign(client, { calls });
}

function recordingStorage(): AuditStorageBackend & { uploads: AuditEvent[][] } {
  const uploads: AuditEvent[][] = [];
  return Object.assign(
    {
      async upload(events: readonly AuditEvent[]): Promise<string> {
        uploads.push([...events]);
        return `0xaudit-${uploads.length}`;
      },
    },
    { uploads },
  );
}

describe('router — keeper integration', () => {
  it('calls keeper.settle for fast mode and includes txHash in audit', async () => {
    const adapter = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [makeProvider({ id: 'x402:fp' })],
    });
    const keeper = makeKeeper();
    const storage = recordingStorage();
    const audit = createAuditWriter({ storage, flushIntervalMs: 100_000 });
    const router = createRouter({
      pool: createPool([adapter]),
      adapters: adapterMap([adapter]),
      keeper,
      audit,
      agentInftId: '7',
    });
    const result = await router.route(makeIntent({ mode: 'fast' }), makeScope());
    expect(result.ok).toBe(true);
    expect(keeper.calls).toHaveLength(1);
    expect(keeper.calls[0]!.tx).toBe('rcpt-x402:fp');
    await audit.flush();
    expect(storage.uploads).toHaveLength(1);
    const ev = storage.uploads[0]![0]!;
    expect(ev.keeperhub_txs).toEqual(['0xkeeper-1']);
    expect(ev.agent_inft).toBe('7');
    expect(ev.mode).toBe('fast');
  });

  it('returns settlement_failed when keeper fails (settlement_failed kind)', async () => {
    const adapter = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [makeProvider()],
    });
    const keeper = makeKeeper({ fail: true });
    const router = createRouter({
      pool: createPool([adapter]),
      adapters: adapterMap([adapter]),
      keeper,
    });
    const result = await router.route(makeIntent({ mode: 'fast' }), makeScope());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('settlement_failed');
  });

  it('returns settlement_failed for transport-kind keeper errors (regression: phase tag)', async () => {
    // Regression test for the prior bug where startsWith('settlement') only
    // caught 'settlement_failed'-kind errors. transport errors must also map.
    const adapter = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [makeProvider()],
    });
    const transportFailingKeeper: KeeperClient = {
      async settle() {
        return {
          ok: false,
          error: { kind: 'transport' as const, reason: 'mcp 502' },
        };
      },
      async close() {
        /* noop */
      },
    };
    const router = createRouter({
      pool: createPool([adapter]),
      adapters: adapterMap([adapter]),
      keeper: transportFailingKeeper,
    });
    const result = await router.route(makeIntent({ mode: 'fast' }), makeScope());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('settlement_failed');
      if (result.error.kind === 'settlement_failed') {
        expect(result.error.reason).toContain('transport');
      }
    }
  });

  it('returns settlement_failed for malformed_response keeper errors', async () => {
    const adapter = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [makeProvider()],
    });
    const malformedKeeper: KeeperClient = {
      async settle() {
        return {
          ok: false,
          error: { kind: 'malformed_response' as const, reason: 'no txHash' },
        };
      },
      async close() {
        /* noop */
      },
    };
    const router = createRouter({
      pool: createPool([adapter]),
      adapters: adapterMap([adapter]),
      keeper: malformedKeeper,
    });
    const result = await router.route(makeIntent({ mode: 'fast' }), makeScope());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('settlement_failed');
  });

  it('settles all 3 providers in consensus mode and records all keeperhub_txs', async () => {
    const x402 = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [
        makeProvider({ id: 'x402:a' }),
        makeProvider({ id: 'x402:b' }),
      ],
    });
    const zg = makeAdapter({
      id: 'zg',
      tee: true,
      providers: [makeProvider({ id: 'zg:t', tee: true, adapter: 'zg' })],
    });
    const keeper = makeKeeper();
    const storage = recordingStorage();
    const audit = createAuditWriter({ storage, flushIntervalMs: 100_000 });
    const router = createRouter({
      pool: createPool([x402, zg]),
      adapters: adapterMap([x402, zg]),
      keeper,
      audit,
      agentInftId: '9',
    });
    const result = await router.route(
      makeIntent({ mode: 'consensus', max_cost_usd: 0.001 }),
      makeScope(),
    );
    expect(result.ok).toBe(true);
    expect(keeper.calls).toHaveLength(3);
    await audit.flush();
    const ev = storage.uploads[0]![0]!;
    expect(ev.keeperhub_txs).toHaveLength(3);
  });

  it('returns no_consensus when below quorum (1 of 3 settles)', async () => {
    // Regression test for the silent-degrade bug: 1-of-3 settlement is not
    // consensus, it's a single-provider call. Must escalate to no_consensus.
    const x402 = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [
        makeProvider({ id: 'x402:a' }),
        makeProvider({ id: 'x402:b' }),
      ],
    });
    const zg = makeAdapter({
      id: 'zg',
      tee: true,
      providers: [makeProvider({ id: 'zg:t', tee: true, adapter: 'zg' })],
    });
    // Keeper succeeds only for the first call (alphabetically, x402:a),
    // fails the other two. successes = 1 < CONSENSUS_MIN_QUORUM (2).
    let n = 0;
    const flakyKeeper: KeeperClient = {
      async settle() {
        n += 1;
        if (n === 1) {
          return { ok: true as const, value: { txHash: '0xkeeper', confirmed: true } };
        }
        return {
          ok: false as const,
          error: { kind: 'transport' as const, reason: 'simulated' },
        };
      },
      async close() {
        /* noop */
      },
    };
    const router = createRouter({
      pool: createPool([x402, zg]),
      adapters: adapterMap([x402, zg]),
      keeper: flakyKeeper,
    });
    const result = await router.route(
      makeIntent({ mode: 'consensus', max_cost_usd: 0.001 }),
      makeScope(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('no_consensus');
      if (result.error.kind === 'no_consensus') {
        expect(result.error.reason).toMatch(/at least \d+ successful providers/);
      }
    }
  });

  it('settles both steps in pipeline mode', async () => {
    const research = makeProvider({ id: 'x402:r' });
    const decision = makeProvider({ id: 'zg:d', tee: true, adapter: 'zg' });
    const x402 = makeAdapter({ id: 'x402', tee: false, providers: [research] });
    const zg = makeAdapter({ id: 'zg', tee: true, providers: [decision] });
    const keeper = makeKeeper();
    const router = createRouter({
      pool: createPool([x402, zg]),
      adapters: adapterMap([x402, zg]),
      keeper,
    });
    const result = await router.route(
      makeIntent({ mode: 'pipeline', max_cost_usd: 0.001 }),
      makeScope(),
    );
    expect(result.ok).toBe(true);
    expect(keeper.calls).toHaveLength(2);
  });

  it('uses correct chain id per adapter', async () => {
    const x402 = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [makeProvider({ id: 'x402:c' })],
    });
    const keeper = makeKeeper();
    const router = createRouter({
      pool: createPool([x402]),
      adapters: adapterMap([x402]),
      keeper,
    });
    await router.route(makeIntent({ mode: 'fast' }), makeScope());
    expect(keeper.calls[0]!.chain).toBe(84532); // BASE_SEPOLIA_CHAIN_ID
  });
});

describe('router — audit integration', () => {
  it('audit_cid is null at route return; filled via route.audit_flushed event', async () => {
    const adapter = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [makeProvider()],
    });
    const storage = recordingStorage();
    const audit = createAuditWriter({ storage, flushIntervalMs: 100_000 });
    const events = new RouterEventBus();
    let flushedCid: string | null = null;
    events.on('route.audit_flushed', ({ audit_cid }) => {
      flushedCid = audit_cid;
    });
    const router = createRouter({
      pool: createPool([adapter]),
      adapters: adapterMap([adapter]),
      audit,
      events,
    });
    const result = await router.route(makeIntent(), makeScope());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.audit_cid).toBeNull();
    await audit.flush();
    expect(flushedCid).not.toBeNull();
    expect(flushedCid).toMatch(/^0xaudit-/);
  });

  it('audit event contains hashed prompt, never raw text', async () => {
    const adapter = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [makeProvider()],
    });
    const storage = recordingStorage();
    const audit = createAuditWriter({ storage, flushIntervalMs: 100_000 });
    const router = createRouter({
      pool: createPool([adapter]),
      adapters: adapterMap([adapter]),
      audit,
    });
    await router.route(
      makeIntent({ prompt: 'CONFIDENTIAL TRADE SECRET' }),
      makeScope(),
    );
    await audit.flush();
    const serialized = JSON.stringify(storage.uploads[0]);
    expect(serialized).not.toContain('CONFIDENTIAL TRADE SECRET');
    expect(storage.uploads[0]![0]!.prompt_hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('emits route.audit_enqueued when audit is configured', async () => {
    const adapter = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [makeProvider()],
    });
    const events = new RouterEventBus();
    const audit = createAuditWriter({ storage: recordingStorage(), flushIntervalMs: 100_000 });
    let enqueued = false;
    events.on('route.audit_enqueued', () => {
      enqueued = true;
    });
    const router = createRouter({
      pool: createPool([adapter]),
      adapters: adapterMap([adapter]),
      audit,
      events,
    });
    await router.route(makeIntent(), makeScope());
    expect(enqueued).toBe(true);
  });

  it('skips audit + keeper when neither is configured (dev fast-path)', async () => {
    const adapter = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [makeProvider()],
    });
    const router = createRouter({
      pool: createPool([adapter]),
      adapters: adapterMap([adapter]),
    });
    const result = await router.route(makeIntent(), makeScope());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.audit_cid).toBeNull();
      expect(result.value.receipts).toHaveLength(1);
    }
  });
});
