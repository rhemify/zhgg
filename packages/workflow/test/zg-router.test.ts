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

/// Like `okBody` but emits a `trace` block — the path inferZG inspects
/// when `verify_tee: true` is sent. When `attestation` is supplied it's
/// forwarded as the `x-tee-attestation` header (envelope JSON or base64).
function okBodyWithTrace(opts: {
  text?: string;
  trace?: { tee_verified?: boolean; provider?: string };
  attestation?: string;
}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.attestation) headers['x-tee-attestation'] = opts.attestation;
  return new Response(
    JSON.stringify({
      id: 'cmpl-test-1',
      model: 'qwen3.6-plus',
      choices: [{ message: { role: 'assistant', content: opts.text ?? 'ok' } }],
      usage: { total_tokens: 100 },
      ...(opts.trace ? { trace: opts.trace } : {}),
    }),
    { status: 200, headers }
  );
}

/// Build a minimal LLM-shape attestation envelope for sidecar tests.
/// Matches the shape `verifyTeeAttestation` and `reverifyAttestationLocally`
/// expect (intel_quote, signing_address, signing_algo, request_nonce).
function llmEnvelope(opts: { signing_address?: string; nonce?: string } = {}) {
  return JSON.stringify({
    intel_quote: '0x' + 'ab'.repeat(40), // ≥64 chars to clear length check
    signing_address: opts.signing_address ?? '0xcA11E7c00Ffe5c0De0000000000000000000beeF',
    signing_algo: 'ecdsa',
    request_nonce: opts.nonce ?? '0x' + '11'.repeat(32),
  });
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
    expect(captured!.url).toBe('https://router-api-testnet.integratenetwork.work/v1/chat/completions');
    expect(captured!.headers.get('authorization')).toBe(`Bearer ${FAKE_KEY}`);
    const parsed = JSON.parse(captured!.body);
    expect(parsed.model).toBe('glm-5-fp8');
    expect(parsed.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('returns Err config when API key is empty', async () => {
    const result = await inferZG('p', { apiKey: '', fetchImpl: mockFetch(() => okBody('x')) });
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

  describe('verify_tee=true body parsing (codex Q5 + closes TODOS gap #5)', () => {
    it('trace.tee_verified=true + header present → attestation_root=tee_verified:<provider>, sidecar gets envelope', async () => {
      let verifierBody: string | null = null;
      const fetchImpl = mockFetch(async (req) => {
        if (req.url.includes('/verify')) {
          verifierBody = await req.text();
          return new Response(JSON.stringify({ valid: true }), { status: 200 });
        }
        return okBodyWithTrace({
          trace: { tee_verified: true, provider: 'qwen-tee-1' },
          attestation: llmEnvelope(),
        });
      });
      const result = await inferZG('p', {
        apiKey: FAKE_KEY,
        verifyTee: true,
        teeVerifierUrl: 'http://verifier.local/verify',
        fetchImpl,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value.attestation_root).toBe('tee_verified:qwen-tee-1');
      expect(result.value.tee_verified_locally).toBe(true);
      // Structured TEE fields surface the router's actual trace verdict
      // — independent of the legacy `attestation_root` sentinel string.
      // Regulator-side parsers can now bind on a typed boolean instead
      // of pattern-matching the sentinel.
      expect(result.value.tee_verified).toBe(true);
      expect(result.value.tee_provider).toBe('qwen-tee-1');
      // Sidecar must have received the envelope's intel_quote + signing_address.
      expect(verifierBody).not.toBeNull();
      const sentToVerifier = JSON.parse(verifierBody!);
      expect(sentToVerifier.signing_address).toBe('0xcA11E7c00Ffe5c0De0000000000000000000beeF');
      expect(typeof sentToVerifier.intel_quote).toBe('string');
    });

    it('trace.tee_verified=true + no header → attestation_root set, sidecar reports no_attestation_envelope', async () => {
      const fetchImpl = mockFetch(async (req) => {
        if (req.url.includes('/verify')) {
          throw new Error('verifier should not be called when header absent');
        }
        return okBodyWithTrace({
          trace: { tee_verified: true, provider: 'qwen-tee-1' },
          // no attestation header
        });
      });
      const result = await inferZG('p', {
        apiKey: FAKE_KEY,
        verifyTee: true,
        teeVerifierUrl: 'http://verifier.local/verify',
        fetchImpl,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      // attestation_root reflects the trace boolean even without an
      // envelope (the trace is the Router's verdict, the envelope is
      // for our independent re-verification).
      expect(result.value.attestation_root).toBe('tee_verified:qwen-tee-1');
      expect(result.value.tee_verified_locally).toBeNull();
      expect(result.value.tee_verifier_reason).toBe('no_attestation_envelope');
      // Structured fields independent of the envelope — present whenever
      // the router returned a trace, regardless of header attestation.
      expect(result.value.tee_verified).toBe(true);
      expect(result.value.tee_provider).toBe('qwen-tee-1');
    });

    it('trace.tee_verified=false → attestation_root falls back to header (or null), no sidecar call', async () => {
      let verifierCalled = false;
      const fetchImpl = mockFetch(async (req) => {
        if (req.url.includes('/verify')) {
          verifierCalled = true;
          return new Response(JSON.stringify({ valid: false }), { status: 200 });
        }
        return okBodyWithTrace({
          trace: { tee_verified: false },
          // no attestation header — confirms attestation_root === null
        });
      });
      const result = await inferZG('p', {
        apiKey: FAKE_KEY,
        verifyTee: true,
        teeVerifierUrl: 'http://verifier.local/verify',
        fetchImpl,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value.attestation_root).toBeNull();
      // No header → reverifyAttestationLocally short-circuits without
      // hitting the sidecar.
      expect(verifierCalled).toBe(false);
      expect(result.value.tee_verifier_reason).toBe('no_attestation_envelope');
      // Structured: router explicitly said `false` — record that, don't
      // collapse to null. Regulator can distinguish "router rejected"
      // from "no trace returned."
      expect(result.value.tee_verified).toBe(false);
      expect(result.value.tee_provider).toBeNull();
    });

    it('no trace block → tee_verified + tee_provider both null (honest unknown)', async () => {
      // When the router doesn't return a trace block at all (e.g.
      // verifyTee not requested, or older router build), both structured
      // fields stay `null`. This is the "honest unknown" path — never
      // silently `false`, which would imply the router rejected.
      const fetchImpl = mockFetch(async () => okBody('ok'));
      const result = await inferZG('p', {
        apiKey: FAKE_KEY,
        // verifyTee NOT set
        fetchImpl,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value.tee_verified).toBeNull();
      expect(result.value.tee_provider).toBeNull();
    });

    it('header present but envelope missing signing_address → envelope_missing_required_fields', async () => {
      let verifierCalled = false;
      const fetchImpl = mockFetch(async (req) => {
        if (req.url.includes('/verify')) {
          verifierCalled = true;
          return new Response(JSON.stringify({ valid: true }), { status: 200 });
        }
        return okBodyWithTrace({
          trace: { tee_verified: true, provider: 'qwen-tee-1' },
          attestation: JSON.stringify({ intel_quote: '0x' + 'ab'.repeat(40) }),
        });
      });
      const result = await inferZG('p', {
        apiKey: FAKE_KEY,
        verifyTee: true,
        teeVerifierUrl: 'http://verifier.local/verify',
        fetchImpl,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value.tee_verified_locally).toBeNull();
      expect(result.value.tee_verifier_reason).toBe('envelope_missing_required_fields');
      // Sidecar must NOT be called when our pre-validation rejects the envelope.
      expect(verifierCalled).toBe(false);
    });
  });
});
