/// Coverage for the synthetic-inference fallback used by `--live` runs
/// when ZG_ROUTER_KEY is unset. The mock impl must:
///   - return ok=true with a deterministic shape (never throws)
///   - mark the response as un-verified TEE (`tee_verified_locally: null`)
///   - tag itself as synthetic in `tee_verifier_reason` and `provider_id`
///     so any observer of the transcript can prove the run was mock
///   - prefix the `receipt` with `cmpl-mock-` (the `0x6d6f636b` ASCII
///     sentinel for "mock") — never collide with a real TEE receipt id

import { describe, it, expect } from 'bun:test';
import { syntheticInferImpl } from '../src/live-deps-mock.js';

describe('syntheticInferImpl — synthetic 0G inference fallback', () => {
  it('returns ok=true with the synthetic mock shape', async () => {
    const r = await syntheticInferImpl('any prompt', { apiKey: 'sk-ignored' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cost_usd).toBe(0.0006);
    expect(r.value.latency_ms).toBe(240);
    expect(r.value.attestation_root).toBeNull();
    expect(r.value.provider_id).toBe('qwen3.6-plus-mock');
  });

  it('never claims TEE verification — tee_verified_locally stays null', async () => {
    const r = await syntheticInferImpl('p', { apiKey: 'sk-x' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tee_verified_locally).toBeNull();
    expect(r.value.tee_verifier_reason).toBe('synthetic-inference (ZG_ROUTER_KEY unset)');
  });

  it('emits a parseable JSON body with compliant=true and a finding string', async () => {
    const r = await syntheticInferImpl('p', { apiKey: 'sk-x' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(r.value.response) as { compliant: boolean; finding: string };
    expect(parsed.compliant).toBe(true);
    expect(typeof parsed.finding).toBe('string');
    expect(parsed.finding.length).toBeGreaterThan(0);
  });

  it('uses the mock-prefix receipt sentinel so it cannot be confused with a real one', async () => {
    const r = await syntheticInferImpl('p', { apiKey: 'sk-x' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.receipt.startsWith('cmpl-mock-')).toBe(true);
  });
});
