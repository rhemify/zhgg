import { describe, it, expect } from 'bun:test';
import {
  createOpenClawProvider,
  ZHGG_MODEL_MAPPING,
  ZHGG_SUPPORTED_MODELS,
  type OpenClawCompletionRequest,
} from '../../src/providers/openclaw.js';
import { createPool } from '../../src/pool.js';
import { createRouter } from '../../src/router.js';
import type { InferenceAdapter } from '../../src/adapters/types.js';
import type { Adapter, InferenceResult, Provider } from '../../src/intent.js';
import type { ExecutionScope } from '../../src/scope.js';

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'x402:test',
    model: 'm',
    tee: false,
    price_per_call_usd: 0.0001,
    latency_p50_ms: 200,
    adapter: 'x402',
    ...overrides,
  };
}

function makeAdapter(opts: {
  id: 'zg' | 'x402';
  tee: boolean;
  providers: Provider[];
  inferReturns?: (provider: Provider, prompt: string) => InferenceResult;
}): InferenceAdapter {
  return {
    id: opts.id,
    capabilities: { tee: opts.tee },
    async listProviders() {
      return opts.providers;
    },
    async infer(p: Provider, prompt: string) {
      const result = opts.inferReturns
        ? opts.inferReturns(p, prompt)
        : {
            response: `${p.id}-resp`,
            cost_usd: p.price_per_call_usd,
            latency_ms: p.latency_p50_ms,
            attestation_root: opts.tee ? `att-${p.id}` : null,
            receipt: `rcpt-${p.id}`,
            provider_id: p.id,
          };
      return { ok: true as const, value: result };
    },
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

function buildPlugin(adapters: InferenceAdapter[], scopeOverrides?: Partial<ExecutionScope>) {
  const adapterMap = new Map<Adapter, InferenceAdapter>();
  for (const a of adapters) adapterMap.set(a.id, a);
  const router = createRouter({
    pool: createPool(adapters),
    adapters: adapterMap,
  });
  const scope = makeScope(scopeOverrides);
  return createOpenClawProvider({ router, scope });
}

const baseRequest: OpenClawCompletionRequest = {
  model: 'zhgg/fast',
  messages: [{ role: 'user', content: 'hello' }],
};

describe('openclaw provider — model registry', () => {
  it('exports model→mode mapping', () => {
    expect(ZHGG_MODEL_MAPPING['zhgg/fast']).toBe('fast');
    expect(ZHGG_MODEL_MAPPING['zhgg/verified']).toBe('verified');
    expect(ZHGG_MODEL_MAPPING['zhgg/consensus']).toBe('consensus');
    expect(ZHGG_MODEL_MAPPING['zhgg/pipeline']).toBe('pipeline');
  });

  it('zhgg/auto maps to verified (fail-safe default)', () => {
    expect(ZHGG_MODEL_MAPPING['zhgg/auto']).toBe('verified');
  });

  it('lists 5 supported models', () => {
    expect(ZHGG_SUPPORTED_MODELS).toContain('zhgg/fast');
    expect(ZHGG_SUPPORTED_MODELS).toContain('zhgg/verified');
    expect(ZHGG_SUPPORTED_MODELS).toContain('zhgg/consensus');
    expect(ZHGG_SUPPORTED_MODELS).toContain('zhgg/pipeline');
    expect(ZHGG_SUPPORTED_MODELS).toContain('zhgg/auto');
    expect(ZHGG_SUPPORTED_MODELS.length).toBe(5);
  });
});

describe('openclaw provider — plugin shape', () => {
  it('exposes id, displayName, models, handler', () => {
    const x402 = makeAdapter({ id: 'x402', tee: false, providers: [provider()] });
    const plugin = buildPlugin([x402]);
    expect(plugin.id).toBe('zhgg');
    expect(typeof plugin.displayName).toBe('string');
    expect(plugin.models.length).toBe(5);
    expect(typeof plugin.handler).toBe('function');
  });

  it('models include capability tags', () => {
    const x402 = makeAdapter({ id: 'x402', tee: false, providers: [provider()] });
    const plugin = buildPlugin([x402]);
    const verified = plugin.models.find((m) => m.id === 'zhgg/verified')!;
    expect(verified.capabilities).toContain('tee');
    const consensus = plugin.models.find((m) => m.id === 'zhgg/consensus')!;
    expect(consensus.capabilities).toContain('consensus');
    expect(consensus.capabilities).toContain('tee');
  });
});

describe('openclaw provider — handler success path', () => {
  it('routes fast mode to cheapest provider', async () => {
    const x402 = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [
        provider({ id: 'x402:cheap', price_per_call_usd: 0.00005 }),
        provider({ id: 'x402:exp', price_per_call_usd: 0.001 }),
      ],
    });
    const plugin = buildPlugin([x402]);
    const r = await plugin.handler({
      ...baseRequest,
      model: 'zhgg/fast',
    });
    expect(r.choices[0]!.message.content).toBe('x402:cheap-resp');
    expect(r.choices[0]!.finish_reason).toBe('stop');
    expect(r.zhgg.mode).toBe('fast');
    expect(r.zhgg.provider_ids).toEqual(['x402:cheap']);
  });

  it('routes verified mode to TEE provider', async () => {
    const x402 = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [provider({ id: 'x402:cheap' })],
    });
    const zg = makeAdapter({
      id: 'zg',
      tee: true,
      providers: [provider({ id: 'zg:t', tee: true, adapter: 'zg' })],
    });
    const plugin = buildPlugin([x402, zg]);
    const r = await plugin.handler({ ...baseRequest, model: 'zhgg/verified' });
    expect(r.zhgg.mode).toBe('verified');
    expect(r.zhgg.provider_ids).toEqual(['zg:t']);
    expect(r.zhgg.attestation_root).not.toBeNull();
  });

  it('joins multi-turn messages with role labels', async () => {
    let promptSeen = '';
    const x402 = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [provider()],
      inferReturns: (p, prompt) => {
        promptSeen = prompt;
        return {
          response: 'ok',
          cost_usd: p.price_per_call_usd,
          latency_ms: p.latency_p50_ms,
          attestation_root: null,
          receipt: 'r',
          provider_id: p.id,
        };
      },
    });
    const plugin = buildPlugin([x402]);
    await plugin.handler({
      model: 'zhgg/fast',
      messages: [
        { role: 'system', content: 'You are a market analyst.' },
        { role: 'user', content: 'classify ETH' },
        { role: 'assistant', content: 'bullish' },
        { role: 'user', content: 'now BTC' },
      ],
    });
    expect(promptSeen).toContain('System: You are a market analyst.');
    expect(promptSeen).toContain('User: classify ETH');
    expect(promptSeen).toContain('Assistant: bullish');
    expect(promptSeen).toContain('User: now BTC');
  });

  it('exposes route metadata in zhgg field', async () => {
    const x402 = makeAdapter({ id: 'x402', tee: false, providers: [provider()] });
    const plugin = buildPlugin([x402]);
    const r = await plugin.handler(baseRequest);
    expect(r.zhgg.cost_usd).toBeGreaterThan(0);
    expect(r.zhgg.latency_ms).toBeGreaterThanOrEqual(0);
    expect(r.zhgg.receipts.length).toBeGreaterThan(0);
    expect(r.zhgg.provider_ids.length).toBeGreaterThan(0);
  });

  it('honors metadata overrides for cost / latency / output_type', async () => {
    let promptSeen = '';
    const x402 = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [provider({ price_per_call_usd: 0.00005 })],
      inferReturns: (p, prompt) => {
        promptSeen = prompt;
        return {
          response: 'ok',
          cost_usd: p.price_per_call_usd,
          latency_ms: p.latency_p50_ms,
          attestation_root: null,
          receipt: 'r',
          provider_id: p.id,
        };
      },
    });
    const plugin = buildPlugin([x402]);
    const r = await plugin.handler({
      model: 'zhgg/fast',
      messages: [{ role: 'user', content: 'test' }],
      metadata: { max_cost_usd: 0.0001, max_latency_ms: 1000, output_type: 'categorical' },
    });
    expect(r.choices[0]!.finish_reason).toBe('stop');
    expect(promptSeen).toContain('test');
  });
});

describe('openclaw provider — error pass-through', () => {
  it('throws on unsupported model', async () => {
    const x402 = makeAdapter({ id: 'x402', tee: false, providers: [provider()] });
    const plugin = buildPlugin([x402]);
    await expect(
      plugin.handler({ ...baseRequest, model: 'gpt-4' }),
    ).rejects.toThrow(/unsupported model/);
  });

  it('throws on policy violation with structured reason', async () => {
    const x402 = makeAdapter({ id: 'x402', tee: false, providers: [provider()] });
    const plugin = buildPlugin([x402], { allowedModes: ['fast'] });
    await expect(
      plugin.handler({ ...baseRequest, model: 'zhgg/consensus' }),
    ).rejects.toThrow(/policy/);
  });

  it('throws on no_provider when pool is empty', async () => {
    const x402 = makeAdapter({ id: 'x402', tee: false, providers: [] });
    const plugin = buildPlugin([x402]);
    await expect(plugin.handler(baseRequest)).rejects.toThrow(/no_provider/);
  });

  it('throws on no_provider for verified mode without TEE adapter', async () => {
    const x402 = makeAdapter({ id: 'x402', tee: false, providers: [provider()] });
    const plugin = buildPlugin([x402]);
    await expect(
      plugin.handler({ ...baseRequest, model: 'zhgg/verified' }),
    ).rejects.toThrow(/no_provider/);
  });
});

describe('openclaw provider — finish_reason', () => {
  it("returns 'stop' on successful inference", async () => {
    const x402 = makeAdapter({ id: 'x402', tee: false, providers: [provider()] });
    const plugin = buildPlugin([x402]);
    const r = await plugin.handler(baseRequest);
    expect(r.choices[0]!.finish_reason).toBe('stop');
  });

  it("returns 'low_confidence' when consensus disagrees", async () => {
    const x402 = makeAdapter({
      id: 'x402',
      tee: false,
      providers: [
        provider({ id: 'x402:a' }),
        provider({ id: 'x402:b' }),
      ],
      inferReturns: (p) => ({
        response: p.id === 'x402:a' ? 'bullish' : 'bearish',
        cost_usd: p.price_per_call_usd,
        latency_ms: p.latency_p50_ms,
        attestation_root: null,
        receipt: 'r',
        provider_id: p.id,
      }),
    });
    const zg = makeAdapter({
      id: 'zg',
      tee: true,
      providers: [provider({ id: 'zg:t', tee: true, adapter: 'zg' })],
      inferReturns: (p) => ({
        response: 'neutral',
        cost_usd: p.price_per_call_usd,
        latency_ms: p.latency_p50_ms,
        attestation_root: 'tee-root',
        receipt: 'r',
        provider_id: p.id,
      }),
    });
    const plugin = buildPlugin([x402, zg]);
    const r = await plugin.handler({
      model: 'zhgg/consensus',
      messages: [{ role: 'user', content: 'test' }],
      metadata: { max_cost_usd: 0.01, output_type: 'categorical' },
    });
    expect(r.choices[0]!.finish_reason).toBe('low_confidence');
    expect(r.zhgg.low_confidence).toBe(true);
  });
});
