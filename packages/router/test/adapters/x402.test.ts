import { describe, it, expect } from 'bun:test';
import {
  createX402Adapter,
  stubPayRequest,
  type BazaarSearchResult,
  type PayRequest,
} from '../../src/adapters/x402.js';
import type { Provider } from '../../src/intent.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function badResponse(status: number): Response {
  return new Response('', { status });
}

function malformedResponse(): Response {
  return new Response('not-json{{{', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const sampleSearch: BazaarSearchResult = {
  services: [
    {
      id: 'svc-a',
      endpoint: 'https://a.example.com/infer',
      model: 'llama-3-70b',
      pricing: { perCallUsd: 0.0005 },
      latency_p50_ms: 300,
    },
    {
      id: 'svc-b',
      endpoint: 'https://b.example.com/infer',
      model: 'mixtral-8x7b',
      pricing: { perCallUsd: 0.0001 },
      latency_p50_ms: 800,
    },
  ],
};

describe('x402 adapter capabilities', () => {
  it('exposes tee=false', () => {
    const adapter = createX402Adapter();
    expect(adapter.capabilities.tee).toBe(false);
    expect(adapter.id).toBe('x402');
  });
});

describe('x402 adapter — listProviders', () => {
  it('returns empty when fetch throws (network error)', async () => {
    const adapter = createX402Adapter({
      fetcher: (async () => {
        throw new Error('boom');
      }) as unknown as typeof fetch,
    });
    const result = await adapter.listProviders();
    expect(result).toEqual([]);
  });

  it('returns empty on non-200', async () => {
    const adapter = createX402Adapter({
      fetcher: (async () => badResponse(503)) as unknown as typeof fetch,
    });
    const result = await adapter.listProviders();
    expect(result).toEqual([]);
  });

  it('returns empty on malformed JSON', async () => {
    const adapter = createX402Adapter({
      fetcher: (async () => malformedResponse()) as unknown as typeof fetch,
    });
    const result = await adapter.listProviders();
    expect(result).toEqual([]);
  });

  it('returns empty on shape-mismatched JSON', async () => {
    const adapter = createX402Adapter({
      fetcher: (async () =>
        jsonResponse({ wrong: 'shape' })) as unknown as typeof fetch,
    });
    const result = await adapter.listProviders();
    expect(result).toEqual([]);
  });

  it('maps services correctly with tee=false and adapter=x402', async () => {
    const adapter = createX402Adapter({
      fetcher: (async () => jsonResponse(sampleSearch)) as unknown as typeof fetch,
    });
    const result = await adapter.listProviders();
    expect(result).toHaveLength(2);
    for (const p of result) {
      expect(p.tee).toBe(false);
      expect(p.adapter).toBe('x402');
      expect(p.id.startsWith('x402:')).toBe(true);
    }
    const a = result.find((p) => p.id === 'x402:svc-a')!;
    expect(a.model).toBe('llama-3-70b');
    expect(a.endpoint).toBe('https://a.example.com/infer');
    expect(a.price_per_call_usd).toBe(0.0005);
    expect(a.latency_p50_ms).toBe(300);
  });

  it('defaults latency_p50_ms to 500 when missing', async () => {
    const adapter = createX402Adapter({
      fetcher: (async () =>
        jsonResponse({
          services: [
            {
              id: 'svc-x',
              endpoint: 'https://x.example.com',
              model: 'm',
              pricing: { perCallUsd: 0.001 },
            },
          ],
        })) as unknown as typeof fetch,
    });
    const result = await adapter.listProviders();
    expect(result).toHaveLength(1);
    expect(result[0]!.latency_p50_ms).toBe(500);
  });

  it('sorts by price ascending', async () => {
    const adapter = createX402Adapter({
      fetcher: (async () => jsonResponse(sampleSearch)) as unknown as typeof fetch,
    });
    const result = await adapter.listProviders();
    expect(result.map((p) => p.id)).toEqual(['x402:svc-b', 'x402:svc-a']);
  });

  it('honors maxCostUsd in URL query', async () => {
    let capturedUrl = '';
    const adapter = createX402Adapter({
      fetcher: (async (input: string | URL | Request) => {
        capturedUrl = String(input);
        return jsonResponse(sampleSearch);
      }) as unknown as typeof fetch,
    });
    await adapter.listProviders({ maxCostUsd: 0.001 });
    expect(capturedUrl).toContain('maxUsdPrice=0.001');
    expect(capturedUrl).toContain('q=inference');
  });

  it('omits maxUsdPrice when maxCostUsd undefined', async () => {
    let capturedUrl = '';
    const adapter = createX402Adapter({
      fetcher: (async (input: string | URL | Request) => {
        capturedUrl = String(input);
        return jsonResponse(sampleSearch);
      }) as unknown as typeof fetch,
    });
    await adapter.listProviders();
    expect(capturedUrl).not.toContain('maxUsdPrice');
  });

  it('honors maxLatencyMs as client-side filter', async () => {
    const adapter = createX402Adapter({
      fetcher: (async () => jsonResponse(sampleSearch)) as unknown as typeof fetch,
    });
    const result = await adapter.listProviders({ maxLatencyMs: 500 });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('x402:svc-a');
  });

  it('cache hit avoids second HTTP call within TTL', async () => {
    let calls = 0;
    const adapter = createX402Adapter({
      cacheTtlMs: 5_000,
      fetcher: (async () => {
        calls += 1;
        return jsonResponse(sampleSearch);
      }) as unknown as typeof fetch,
    });
    await adapter.listProviders({ maxCostUsd: 0.01 });
    await adapter.listProviders({ maxCostUsd: 0.01 });
    expect(calls).toBe(1);
  });

  it('cache miss after TTL expires', async () => {
    let calls = 0;
    const adapter = createX402Adapter({
      cacheTtlMs: 30,
      fetcher: (async () => {
        calls += 1;
        return jsonResponse(sampleSearch);
      }) as unknown as typeof fetch,
    });
    await adapter.listProviders();
    await new Promise((r) => setTimeout(r, 60));
    await adapter.listProviders();
    expect(calls).toBe(2);
  });

  it('cache miss for different params', async () => {
    let calls = 0;
    const adapter = createX402Adapter({
      fetcher: (async () => {
        calls += 1;
        return jsonResponse(sampleSearch);
      }) as unknown as typeof fetch,
    });
    await adapter.listProviders({ maxCostUsd: 0.01 });
    await adapter.listProviders({ maxCostUsd: 0.02 });
    expect(calls).toBe(2);
  });
});

describe('x402 adapter — infer', () => {
  const goodProvider: Provider = {
    id: 'x402:svc-a',
    model: 'llama-3-70b',
    tee: false,
    price_per_call_usd: 0.0005,
    latency_p50_ms: 300,
    adapter: 'x402',
    endpoint: 'https://a.example.com/infer',
  };

  it('rejects non-x402 provider with structured wrong_adapter error', async () => {
    const adapter = createX402Adapter();
    const result = await adapter.infer(
      { ...goodProvider, adapter: 'zg' },
      'hello',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('wrong_adapter');
      expect(result.error.reason).toContain('x402');
    }
  });

  it('rejects provider id without x402: prefix', async () => {
    const adapter = createX402Adapter();
    const result = await adapter.infer(
      { ...goodProvider, id: 'bare-id' },
      'hi',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_provider');
  });

  it('returns successful InferenceResult with mocked payRequest', async () => {
    const payRequest: PayRequest = async () => ({
      response: jsonResponse({
        choices: [{ message: { content: 'hello world' } }],
      }),
      receipt: 'rcpt-123',
    });
    const adapter = createX402Adapter({ payRequest });
    const result = await adapter.infer(goodProvider, 'hi');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.response).toBe('hello world');
      expect(result.value.attestation_root).toBeNull();
      expect(result.value.cost_usd).toBe(0.0005);
      expect(result.value.provider_id).toBe('x402:svc-a');
    }
  });

  it('returns payment_failed error when payRequest throws', async () => {
    const payRequest: PayRequest = async () => {
      throw new Error('insufficient USDC');
    };
    const adapter = createX402Adapter({ payRequest });
    const result = await adapter.infer(goodProvider, 'hi');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('payment_failed');
      expect(result.error.reason).toContain('insufficient USDC');
    }
  });

  it('default (no payRequest) integrates stubPayRequest → payment_failed', async () => {
    const adapter = createX402Adapter();
    const result = await adapter.infer(goodProvider, 'hi');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('payment_failed');
      expect(result.error.reason).toContain('not implemented');
    }
  });

  it('returns transport error on non-2xx response', async () => {
    const payRequest: PayRequest = async () => ({
      response: badResponse(500),
      receipt: 'rcpt-x',
    });
    const adapter = createX402Adapter({ payRequest });
    const result = await adapter.infer(goodProvider, 'hi');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('transport');
      expect(result.error.reason).toContain('500');
    }
  });

  it('returns transport error on empty response content', async () => {
    const payRequest: PayRequest = async () => ({
      response: jsonResponse({ choices: [{ message: { content: '' } }] }),
      receipt: 'rcpt-x',
    });
    const adapter = createX402Adapter({ payRequest });
    const result = await adapter.infer(goodProvider, 'hi');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('transport');
      expect(result.error.reason).toContain('empty');
    }
  });

  it('returns transport error on missing choices', async () => {
    const payRequest: PayRequest = async () => ({
      response: jsonResponse({}),
      receipt: 'rcpt-x',
    });
    const adapter = createX402Adapter({ payRequest });
    const result = await adapter.infer(goodProvider, 'hi');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('transport');
  });

  it('returns transport error on malformed JSON body', async () => {
    const payRequest: PayRequest = async () => ({
      response: malformedResponse(),
      receipt: 'rcpt-x',
    });
    const adapter = createX402Adapter({ payRequest });
    const result = await adapter.infer(goodProvider, 'hi');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('transport');
      expect(result.error.reason).toContain('malformed json');
    }
  });

  it('returns transport error on non-string content', async () => {
    const payRequest: PayRequest = async () => ({
      response: jsonResponse({ choices: [{ message: { content: 42 } }] }),
      receipt: 'rcpt-x',
    });
    const adapter = createX402Adapter({ payRequest });
    const result = await adapter.infer(goodProvider, 'hi');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('transport');
      expect(result.error.reason).toContain('non-string');
    }
  });

  it('populates receipt from payRequest result', async () => {
    const payRequest: PayRequest = async () => ({
      response: jsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }),
      receipt: 'rcpt-abc-xyz',
    });
    const adapter = createX402Adapter({ payRequest });
    const result = await adapter.infer(goodProvider, 'hi');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.receipt).toBe('rcpt-abc-xyz');
  });

  it('measures latency_ms', async () => {
    const payRequest: PayRequest = async () => {
      await new Promise((r) => setTimeout(r, 25));
      return {
        response: jsonResponse({
          choices: [{ message: { content: 'ok' } }],
        }),
        receipt: 'rcpt',
      };
    };
    const adapter = createX402Adapter({ payRequest });
    const result = await adapter.infer(goodProvider, 'hi');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.latency_ms).toBeGreaterThanOrEqual(25);
      expect(result.value.latency_ms).toBeLessThan(5_000);
    }
  });

  it('rejects provider with no endpoint', async () => {
    const adapter = createX402Adapter();
    const result = await adapter.infer(
      { ...goodProvider, endpoint: undefined },
      'hi',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_provider');
      expect(result.error.reason).toContain('endpoint');
    }
  });
});

describe('stubPayRequest', () => {
  it('throws "not implemented" when invoked', async () => {
    const pay = stubPayRequest();
    await expect(pay('https://x', { method: 'POST' })).rejects.toThrow(
      /not implemented in v1/,
    );
  });
});
