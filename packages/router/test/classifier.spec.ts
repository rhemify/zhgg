import { describe, it, expect, mock } from 'bun:test';
import { classifyComplexity, type FetchLike } from '../src/classifier.js';

const API_KEY = 'sk-ant-test-fixture';

function mkAnthropicResponse(text: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      model: 'claude-haiku-4-5-20251001',
      stop_reason: 'end_turn',
    }),
    { status, headers: { 'content-type': 'application/json' } }
  );
}

describe('classifyComplexity — happy path', () => {
  it('parses a clean JSON response with score, recommended, confidence', async () => {
    const fetchImpl = mock(async () =>
      mkAnthropicResponse('{"score": 7, "recommended": "consensus", "confidence": 0.9}')
    ) as unknown as FetchLike;

    const r = await classifyComplexity('write a smart contract for an AMM', {
      apiKey: API_KEY,
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.score).toBe(7);
      expect(r.value.recommended).toBe('consensus');
      expect(r.value.confidence).toBe(0.9);
    }
  });

  it('strips ```json code fences if the model wraps the JSON', async () => {
    const fetchImpl = mock(async () =>
      mkAnthropicResponse('```json\n{"score": 2, "recommended": "fast", "confidence": 0.95}\n```')
    ) as unknown as FetchLike;

    const r = await classifyComplexity('hi', { apiKey: API_KEY, fetchImpl });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.recommended).toBe('fast');
  });
});

describe('classifyComplexity — fail-open paths', () => {
  it('returns not_configured when apiKey is absent', async () => {
    const r = await classifyComplexity('anything', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_configured');
  });

  it('returns transport on network failure', async () => {
    const fetchImpl = mock(async () => {
      throw new Error('econnrefused');
    }) as unknown as FetchLike;

    const r = await classifyComplexity('test', { apiKey: API_KEY, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('transport');
      if (r.error.kind === 'transport') expect(r.error.reason).toContain('econnrefused');
    }
  });

  it('returns transport on Anthropic 5xx', async () => {
    const fetchImpl = mock(
      async () => new Response('', { status: 503 })
    ) as unknown as FetchLike;

    const r = await classifyComplexity('test', { apiKey: API_KEY, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('transport');
      if (r.error.kind === 'transport') expect(r.error.reason).toContain('503');
    }
  });

  it('returns malformed when score is out of range', async () => {
    const fetchImpl = mock(async () =>
      mkAnthropicResponse('{"score": 99, "recommended": "fast", "confidence": 1}')
    ) as unknown as FetchLike;

    const r = await classifyComplexity('test', { apiKey: API_KEY, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('malformed');
  });

  it('returns malformed when recommended is not a known mode', async () => {
    const fetchImpl = mock(async () =>
      mkAnthropicResponse('{"score": 5, "recommended": "yolo", "confidence": 0.8}')
    ) as unknown as FetchLike;

    const r = await classifyComplexity('test', { apiKey: API_KEY, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('malformed');
  });

  it('returns malformed when the model returns non-JSON', async () => {
    const fetchImpl = mock(async () =>
      mkAnthropicResponse("hmm, I think it's a 5? probably consensus.")
    ) as unknown as FetchLike;

    const r = await classifyComplexity('test', { apiKey: API_KEY, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('malformed');
  });

  it('returns malformed when content array is empty', async () => {
    const fetchImpl = mock(
      async () =>
        new Response(JSON.stringify({ content: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    ) as unknown as FetchLike;

    const r = await classifyComplexity('test', { apiKey: API_KEY, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('malformed');
  });

  it('returns malformed when confidence is out of range', async () => {
    const fetchImpl = mock(async () =>
      mkAnthropicResponse('{"score": 5, "recommended": "verified", "confidence": 1.5}')
    ) as unknown as FetchLike;

    const r = await classifyComplexity('test', { apiKey: API_KEY, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('malformed');
  });
});

describe('classifyComplexity — request shape', () => {
  it('sends cache_control on system block + user prompt', async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = mock(async (_url, init) => {
      captured = init;
      return mkAnthropicResponse('{"score":3,"recommended":"fast","confidence":0.9}');
    }) as unknown as FetchLike;

    await classifyComplexity('what is 2+2', { apiKey: API_KEY, fetchImpl });

    expect(captured).toBeDefined();
    const body = JSON.parse(captured!.body as string) as {
      system: Array<{ cache_control?: { type: string } }>;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.system[0]!.cache_control?.type).toBe('ephemeral');
    expect(body.messages[0]!.role).toBe('user');
    expect(body.messages[0]!.content).toBe('what is 2+2');
  });

  it('caps prompts at 4000 chars to keep cost predictable', async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = mock(async (_url, init) => {
      captured = init;
      return mkAnthropicResponse('{"score":1,"recommended":"fast","confidence":0.9}');
    }) as unknown as FetchLike;

    const longPrompt = 'a'.repeat(10_000);
    await classifyComplexity(longPrompt, { apiKey: API_KEY, fetchImpl });

    const body = JSON.parse(captured!.body as string) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0]!.content.length).toBe(4000);
  });
});
