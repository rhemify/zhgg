import { describe, it, expect } from 'bun:test';
import { verifyTeeAttestation } from '../src/tee-attestation.js';

const VALID_ENVELOPE = JSON.stringify({
  signing_address: '0x8a4D4984CF370210dFEeFC773FAf9bb0edE97cC0',
  signing_algo: 'ecdsa',
  request_nonce: '034b9c390f073a9c8f8a1b50e537342fff3952bf2f32f145174e8d87588ed2da',
  // ~440 chars — plausible TDX quote length, ≥ 64 char floor
  intel_quote: '04000200810000000000000000'.repeat(20),
});

describe('verifyTeeAttestation', () => {
  it('missing header → kind=missing', async () => {
    const r = await verifyTeeAttestation(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('missing');
  });

  it('malformed JSON → kind=malformed', async () => {
    const warns: string[] = [];
    const r = await verifyTeeAttestation('this is not json {{', {
      logger: { warn: (m) => warns.push(m) },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('malformed');
    expect(warns.length).toBe(0); // no warning before parse succeeds
  });

  it('valid envelope in RELAXED mode passes + warns', async () => {
    const warns: string[] = [];
    const r = await verifyTeeAttestation(VALID_ENVELOPE, {
      logger: { warn: (m) => warns.push(m) },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.mode).toBe('relaxed');
      expect(r.value.algo).toBe('ecdsa');
      expect(r.value.verifierId).toBe('0x8a4d4984cf370210dfeefc773faf9bb0ede97cc0');
      expect(r.value.quoteBytes).toBeGreaterThan(100);
    }
    expect(warns.some((w) => w.includes('RELAXED'))).toBe(true);
  });

  it('STRICT mode: mock CA returns valid=true → ok with mode=strict', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ valid: true }), { status: 200 });
    const r = await verifyTeeAttestation(VALID_ENVELOPE, {
      strict: true,
      verifierUrl: 'https://mock-verifier.test/verify',
      fetchImpl: fetchImpl as never,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.mode).toBe('strict');
  });

  it('STRICT mode: mock CA returns valid=false → kind=verifier_rejected', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ valid: false, reason: 'tcb_outdated' }), { status: 200 });
    const r = await verifyTeeAttestation(VALID_ENVELOPE, {
      strict: true,
      verifierUrl: 'https://mock-verifier.test/verify',
      fetchImpl: fetchImpl as never,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('verifier_rejected');
      if (r.error.kind === 'verifier_rejected') {
        expect(r.error.reason).toContain('tcb_outdated');
      }
    }
  });

  it('STRICT mode without verifierUrl → kind=verifier_unreachable', async () => {
    const r = await verifyTeeAttestation(VALID_ENVELOPE, { strict: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('verifier_unreachable');
  });

  it('rejects unsupported signing_algo', async () => {
    const env = JSON.stringify({
      signing_address: '0x8a4D4984CF370210dFEeFC773FAf9bb0edE97cC0',
      signing_algo: 'rsa-pss',
      request_nonce: '0xabc',
      intel_quote: '0xdead'.repeat(20),
    });
    const r = await verifyTeeAttestation(env, { logger: { warn: () => {} } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('unsupported_algo');
  });

  it('rejects invalid signing_address', async () => {
    const env = JSON.stringify({
      signing_address: 'not-an-address',
      signing_algo: 'ecdsa',
      request_nonce: '0xabc',
      intel_quote: '0xdead'.repeat(20),
    });
    const r = await verifyTeeAttestation(env, { logger: { warn: () => {} } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('malformed');
  });
});
