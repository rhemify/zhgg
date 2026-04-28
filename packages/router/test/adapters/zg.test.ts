import { describe, it, expect, mock } from 'bun:test';
import {
  createZgAdapterFromBroker,
  type BrokerLike,
  type ZgService,
} from '../../src/adapters/zg.js';
import type { Provider } from '../../src/intent.js';

interface StubBrokerOverrides {
  listService?: () => Promise<readonly ZgService[]>;
  getServiceMetadata?: (
    providerAddress: string,
  ) => Promise<{ endpoint: string; model: string }>;
  getRequestHeaders?: (
    providerAddress: string,
    content: string,
  ) => Promise<Record<string, string>>;
  processResponse?: (
    providerAddress: string,
    chatID?: string,
    content?: string,
  ) => Promise<boolean | null>;
}

function makeService(overrides: Partial<ZgService> = {}): ZgService {
  return {
    provider: '0xprovider1',
    url: 'https://node-a.0g.ai',
    inputPrice: 1_000_000_000_000n,
    outputPrice: 2_000_000_000_000n,
    model: 'Qwen3-7B',
    verifiability: 'TeeML',
    teeSignerAcknowledged: true,
    ...overrides,
  };
}

function makeStubBroker(
  services: readonly ZgService[],
  overrides: StubBrokerOverrides = {},
): BrokerLike {
  return {
    inference: {
      listService: overrides.listService ?? (async () => services),
      getServiceMetadata:
        overrides.getServiceMetadata ??
        (async (addr: string) => ({
          endpoint: services.find((s) => s.provider === addr)?.url ?? 'https://node.0g.ai',
          model: services.find((s) => s.provider === addr)?.model ?? 'Qwen3-7B',
        })),
      getRequestHeaders:
        overrides.getRequestHeaders ??
        (async () => ({ 'X-ZG-Sig': 'stub' })),
      processResponse: overrides.processResponse ?? (async () => true),
    },
  };
}

function makeFetchResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

function zgProvider(id = 'zg:0xprovider1'): Provider {
  return {
    id,
    model: 'Qwen3-7B',
    tee: true,
    price_per_call_usd: 0.0003,
    latency_p50_ms: 1500,
    adapter: 'zg',
    endpoint: 'https://node-a.0g.ai',
  };
}

describe('zg adapter capabilities', () => {
  it('exposes tee=true', () => {
    const adapter = createZgAdapterFromBroker(makeStubBroker([]));
    expect(adapter.capabilities.tee).toBe(true);
    expect(adapter.id).toBe('zg');
  });
});

describe('createZgAdapterFromBroker.listProviders', () => {
  it('returns empty array when broker throws (does not propagate)', async () => {
    const broker = makeStubBroker([], {
      listService: async () => {
        throw new Error('rpc down');
      },
    });
    const adapter = createZgAdapterFromBroker(broker);
    const result = await adapter.listProviders();
    expect(result).toEqual([]);
  });

  it('filters out non-TeeML services', async () => {
    const broker = makeStubBroker([
      makeService({ provider: '0xa', verifiability: 'OpML' }),
      makeService({ provider: '0xb', verifiability: 'ZKML' }),
      makeService({ provider: '0xc', verifiability: 'TeeML' }),
    ]);
    const adapter = createZgAdapterFromBroker(broker);
    const result = await adapter.listProviders();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('zg:0xc');
  });

  it('filters out unacknowledged TEE signers', async () => {
    const broker = makeStubBroker([
      makeService({ provider: '0xa', teeSignerAcknowledged: false }),
      makeService({ provider: '0xb', teeSignerAcknowledged: true }),
    ]);
    const adapter = createZgAdapterFromBroker(broker);
    const result = await adapter.listProviders();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('zg:0xb');
  });

  it('silently drops services with missing critical fields (defensive)', async () => {
    // Cast to ZgService to simulate SDK returning malformed shape.
    const malformed = { provider: '0xbad' } as ZgService;
    const broker = makeStubBroker([malformed, makeService({ provider: '0xgood' })]);
    const adapter = createZgAdapterFromBroker(broker);
    const result = await adapter.listProviders();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('zg:0xgood');
  });

  it('maps service to Provider with tee=true and adapter=zg', async () => {
    const svc = makeService({ provider: '0xabc', model: 'GLM-5-FP8', url: 'https://x.io' });
    const broker = makeStubBroker([svc]);
    const adapter = createZgAdapterFromBroker(broker);
    const [p] = await adapter.listProviders();
    expect(p).toBeDefined();
    expect(p!.id).toBe('zg:0xabc');
    expect(p!.tee).toBe(true);
    expect(p!.adapter).toBe('zg');
    expect(p!.model).toBe('GLM-5-FP8');
    expect(p!.endpoint).toBe('https://x.io');
    expect(p!.latency_p50_ms).toBe(1500);
    expect(p!.price_per_call_usd).toBeGreaterThan(0);
  });

  it('honors maxCostUsd filter', async () => {
    const cheap = makeService({
      provider: '0xcheap',
      inputPrice: 1n,
      outputPrice: 1n,
    });
    const expensive = makeService({
      provider: '0xexp',
      inputPrice: 10n ** 18n,
      outputPrice: 10n ** 18n,
    });
    const broker = makeStubBroker([cheap, expensive]);
    const adapter = createZgAdapterFromBroker(broker);
    const result = await adapter.listProviders({ maxCostUsd: 0.001 });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('zg:0xcheap');
  });

  it('sorts by price ascending', async () => {
    const a = makeService({
      provider: '0xa',
      inputPrice: 5_000_000_000_000n,
      outputPrice: 5_000_000_000_000n,
    });
    const b = makeService({
      provider: '0xb',
      inputPrice: 1_000_000_000_000n,
      outputPrice: 1_000_000_000_000n,
    });
    const c = makeService({
      provider: '0xc',
      inputPrice: 3_000_000_000_000n,
      outputPrice: 3_000_000_000_000n,
    });
    const broker = makeStubBroker([a, b, c]);
    const adapter = createZgAdapterFromBroker(broker);
    const result = await adapter.listProviders();
    expect(result.map((p) => p.id)).toEqual(['zg:0xb', 'zg:0xc', 'zg:0xa']);
  });
});

describe('createZgAdapterFromBroker.infer', () => {
  it('rejects non-zg provider with structured wrong_adapter error', async () => {
    const broker = makeStubBroker([]);
    const adapter = createZgAdapterFromBroker(broker);
    const x402Provider: Provider = {
      id: 'x402:bazaar-x',
      model: 'Llama-3-70B',
      tee: false,
      price_per_call_usd: 0.0001,
      latency_p50_ms: 800,
      adapter: 'x402',
    };
    const result = await adapter.infer(x402Provider, 'hello');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('wrong_adapter');
      expect(result.error.reason).toContain('zg');
    }
  });

  it('rejects provider id without zg: prefix even if adapter says zg', async () => {
    const broker = makeStubBroker([]);
    const adapter = createZgAdapterFromBroker(broker);
    const malformed: Provider = {
      id: '0xprovider1', // missing zg: prefix
      model: 'Qwen3-7B',
      tee: true,
      price_per_call_usd: 0.0003,
      latency_p50_ms: 1500,
      adapter: 'zg',
    };
    const result = await adapter.infer(malformed, 'p');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_provider');
  });

  it('returns successful InferenceResult on 200 + valid attestation', async () => {
    const svc = makeService();
    const broker = makeStubBroker([svc]);
    const fetcher = mock(async () =>
      makeFetchResponse(
        {
          id: 'chat-123',
          choices: [{ message: { content: 'hello world' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
        { headers: { 'ZG-Res-Key': 'res-abc' } },
      ),
    );
    const adapter = createZgAdapterFromBroker(broker, { fetcher: fetcher as unknown as typeof fetch });
    const result = await adapter.infer(zgProvider(), 'tell me a joke');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.response).toBe('hello world');
      // Phase 1 stub: sha256(providerAddress|chatID). Non-null hex root.
      // Phase 3 will replace with the real keccak256(signing-tuple).
      expect(result.value.attestation_root).toMatch(/^0x[0-9a-f]{64}$/);
      // Receipt holds the chatID (used to fetch signature later).
      expect(result.value.receipt).toBe('res-abc');
      expect(result.value.provider_id).toBe('zg:0xprovider1');
      expect(result.value.cost_usd).toBeGreaterThan(0);
      expect(result.value.latency_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('produces deterministic stub attestation_root for same (provider, chatID)', async () => {
    const svc = makeService();
    const broker = makeStubBroker([svc]);
    const fetcher = mock(async () =>
      makeFetchResponse(
        {
          id: 'chat-123',
          choices: [{ message: { content: 'hello' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        { headers: { 'ZG-Res-Key': 'fixed-id' } },
      ),
    );
    const adapter = createZgAdapterFromBroker(broker, { fetcher: fetcher as unknown as typeof fetch });
    const a = await adapter.infer(zgProvider(), 'p1');
    const b = await adapter.infer(zgProvider(), 'p2');
    if (a.ok && b.ok) {
      expect(a.value.attestation_root).toBe(b.value.attestation_root);
    }
  });

  it('returns attestation_failed when processResponse returns false', async () => {
    const svc = makeService();
    const broker = makeStubBroker([svc], {
      processResponse: async () => false,
    });
    const fetcher = mock(async () =>
      makeFetchResponse(
        {
          id: 'chat-123',
          choices: [{ message: { content: 'fake' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        { headers: { 'ZG-Res-Key': 'r' } },
      ),
    );
    const adapter = createZgAdapterFromBroker(broker, { fetcher: fetcher as unknown as typeof fetch });
    const result = await adapter.infer(zgProvider(), 'prompt');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('attestation_failed');
      expect(result.error.reason).toContain('signature mismatch');
    }
  });

  it('returns attestation_failed when processResponse returns null (skipped)', async () => {
    // Simulate broker returning null (e.g., couldn't extract chatID).
    const svc = makeService();
    const broker = makeStubBroker([svc], {
      processResponse: async () => null,
    });
    const fetcher = mock(async () =>
      makeFetchResponse({
        // No id, no ZG-Res-Key header → chatID is empty
        choices: [{ message: { content: 'x' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    const adapter = createZgAdapterFromBroker(broker, { fetcher: fetcher as unknown as typeof fetch });
    const result = await adapter.infer(zgProvider(), 'p');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('attestation_failed');
      expect(result.error.reason).toContain('skipped');
    }
  });

  it('returns transport error on non-200 HTTP', async () => {
    const svc = makeService();
    const broker = makeStubBroker([svc]);
    const fetcher = mock(async () => makeFetchResponse({ error: 'oops' }, { status: 503 }));
    const adapter = createZgAdapterFromBroker(broker, { fetcher: fetcher as unknown as typeof fetch });
    const result = await adapter.infer(zgProvider(), 'prompt');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('transport');
      expect(result.error.reason).toContain('503');
    }
  });

  it('returns transport error on empty response content', async () => {
    const svc = makeService();
    const broker = makeStubBroker([svc]);
    const fetcher = mock(async () =>
      makeFetchResponse(
        {
          id: 'c',
          choices: [{ message: { content: '' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        { headers: { 'ZG-Res-Key': 'r' } },
      ),
    );
    const adapter = createZgAdapterFromBroker(broker, { fetcher: fetcher as unknown as typeof fetch });
    const result = await adapter.infer(zgProvider(), 'p');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('transport');
  });

  it('extracts chatID from ZG-Res-Key header preferentially', async () => {
    const svc = makeService();
    const broker = makeStubBroker([svc]);
    const fetcher = mock(async () =>
      makeFetchResponse(
        {
          id: 'completion-id',
          choices: [{ message: { content: 'x' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        { headers: { 'ZG-Res-Key': 'header-id' } },
      ),
    );
    const adapter = createZgAdapterFromBroker(broker, { fetcher: fetcher as unknown as typeof fetch });
    const result = await adapter.infer(zgProvider(), 'p');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.receipt).toBe('header-id');
    }
  });

  it('falls back to completion.id when no ZG-Res-Key header', async () => {
    const svc = makeService();
    const broker = makeStubBroker([svc]);
    const fetcher = mock(async () =>
      makeFetchResponse({
        id: 'completion-fallback',
        choices: [{ message: { content: 'x' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    const adapter = createZgAdapterFromBroker(broker, { fetcher: fetcher as unknown as typeof fetch });
    const result = await adapter.infer(zgProvider(), 'p');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.receipt).toBe('completion-fallback');
    }
  });

  it('falls through empty ZG-Res-Key header to completion.id (|| not ??)', async () => {
    // Empty string is falsy under || but truthy-empty under ??. SDK doctrine = ||.
    const svc = makeService();
    const broker = makeStubBroker([svc]);
    const fetcher = mock(async () =>
      makeFetchResponse(
        {
          id: 'completion-id',
          choices: [{ message: { content: 'x' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        { headers: { 'ZG-Res-Key': '' } },
      ),
    );
    const adapter = createZgAdapterFromBroker(broker, { fetcher: fetcher as unknown as typeof fetch });
    const result = await adapter.infer(zgProvider(), 'p');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.receipt).toBe('completion-id');
    }
  });

  it('measures latency_ms from fetch start to finish', async () => {
    const svc = makeService();
    const broker = makeStubBroker([svc]);
    const fetcher = mock(async () => {
      await new Promise((r) => setTimeout(r, 25));
      return makeFetchResponse({
        id: 'c1',
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    const adapter = createZgAdapterFromBroker(broker, { fetcher: fetcher as unknown as typeof fetch });
    const result = await adapter.infer(zgProvider(), 'p');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.latency_ms).toBeGreaterThanOrEqual(20);
    }
  });
});
