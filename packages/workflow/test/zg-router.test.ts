import { describe, it, expect } from 'bun:test';
import { inferZG, type FetchLike } from '../src/adapters/zg-router.js';

const FAKE_KEY = 'sk-fake-test-key';

function mockFetch(handler: (req: Request) => Response | Promise<Response>): FetchLike {
  return async (input, init) => {
    const req = input instanceof Request ? input : new Request(input as string, init);
    return handler(req);
  };
}

function okBody(text: string, totalTokens = 100, attestation: string | null = null) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (attestation) headers['x-tee-attestation'] = attestation;
  return new Response(
    JSON.stringify({
      id: 'cmpl-test-1',
      model: 'qwen3.6-plus',
      choices: [{ message: { role: 'assistant', content: text } }],
      usage: { total_tokens: totalTokens },
    }),
    { status: 200, headers }
  );
}

describe('inferZG', () => {
  it('returns Ok with parsed InferenceResult on happy path', async () => {
    const fetchImpl = mockFetch(() => okBody('hello world', 200, '0xabc123'));
    const result = await inferZG('prompt', { apiKey: FAKE_KEY, fetchImpl });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.response).toBe('hello world');
    expect(result.value.attestation_root).toBe('0xabc123');
    expect(result.value.cost_usd).toBeCloseTo(0.0006, 6); // 200 tokens * $0.003/1k
    expect(result.value.receipt).toBe('cmpl-test-1');
    expect(result.value.provider_id).toBe('qwen3.6-plus');
    expect(result.value.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('returns Ok with attestation_root=null when header absent', async () => {
    const fetchImpl = mockFetch(() => okBody('hi'));
    const result = await inferZG('p', { apiKey: FAKE_KEY, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.attestation_root).toBeNull();
  });

  it('sends Authorization header and OpenAI-shaped body', async () => {
    let captured: { url: string; headers: Headers; body: string } | null = null;
    const fetchImpl = mockFetch(async (req) => {
      captured = { url: req.url, headers: req.headers, body: await req.text() };
      return okBody('ok');
    });
    await inferZG('hello', { apiKey: FAKE_KEY, fetchImpl, model: 'glm-5-fp8' });

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('https://router-api.0g.ai/v1/chat/completions');
    expect(captured!.headers.get('authorization')).toBe(`Bearer ${FAKE_KEY}`);
    const parsed = JSON.parse(captured!.body);
    expect(parsed.model).toBe('glm-5-fp8');
    expect(parsed.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('returns Err config when no API key available', async () => {
    const result = await inferZG('p', { fetchImpl: mockFetch(() => okBody('x')) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('config');
  });

  it('returns Err transport on HTTP 500', async () => {
    const fetchImpl = mockFetch(() => new Response('server down', { status: 500 }));
    const result = await inferZG('p', { apiKey: FAKE_KEY, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('transport');
    if (result.error.kind !== 'transport') throw new Error('unreachable');
    expect(result.error.status).toBe(500);
  });

  it('returns Err transport when fetch throws', async () => {
    const fetchImpl = mockFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const result = await inferZG('p', { apiKey: FAKE_KEY, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('transport');
  });

  it('returns Err malformed_response when JSON shape is wrong', async () => {
    const fetchImpl = mockFetch(
      () => new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    const result = await inferZG('p', { apiKey: FAKE_KEY, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('malformed_response');
  });

  it('returns Err malformed_response when body is not valid JSON', async () => {
    const fetchImpl = mockFetch(() => new Response('not-json', { status: 200 }));
    const result = await inferZG('p', { apiKey: FAKE_KEY, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('malformed_response');
  });
});
