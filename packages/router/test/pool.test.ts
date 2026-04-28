import { describe, it, expect } from 'bun:test';
import { createPool } from '../src/pool.js';
import type { InferenceAdapter } from '../src/adapters/types.js';
import type { Provider, InferenceResult } from '../src/intent.js';
import type { Result } from '../src/result.js';

function makeAdapter(
  id: 'zg' | 'x402',
  tee: boolean,
  providers: Provider[],
  opts: { delayMs?: number; throws?: boolean } = {},
): InferenceAdapter {
  return {
    id,
    capabilities: { tee },
    async listProviders(): Promise<Provider[]> {
      if (opts.delayMs !== undefined) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      if (opts.throws === true) {
        throw new Error('adapter blew up');
      }
      return providers;
    },
    async infer(): Promise<Result<InferenceResult, never>> {
      throw new Error('not used in pool tests');
    },
  } as InferenceAdapter;
}

function p(
  id: string,
  adapter: 'zg' | 'x402',
  tee: boolean,
  price: number,
  latency: number,
): Provider {
  return {
    id,
    model: 'm',
    tee,
    price_per_call_usd: price,
    latency_p50_ms: latency,
    adapter,
  };
}

const HIGH_BUDGET = 1;
const HIGH_LATENCY = 10_000;

describe('createPool', () => {
  it('1. empty adapters array → []', async () => {
    const pool = createPool([]);
    const out = await pool.query({
      teeRequired: false,
      maxCostUsd: HIGH_BUDGET,
      maxLatencyMs: HIGH_LATENCY,
    });
    expect(out).toEqual([]);
  });

  it('2. single non-TEE adapter, teeRequired=false → returns its providers', async () => {
    const a = makeAdapter('x402', false, [
      p('x402:a', 'x402', false, 0.001, 200),
      p('x402:b', 'x402', false, 0.002, 300),
    ]);
    const pool = createPool([a]);
    const out = await pool.query({
      teeRequired: false,
      maxCostUsd: HIGH_BUDGET,
      maxLatencyMs: HIGH_LATENCY,
    });
    expect(out.map((x) => x.id)).toEqual(['x402:a', 'x402:b']);
  });

  it('3. single non-TEE adapter, teeRequired=true → []', async () => {
    const a = makeAdapter('x402', false, [p('x402:a', 'x402', false, 0.001, 200)]);
    const pool = createPool([a]);
    const out = await pool.query({
      teeRequired: true,
      maxCostUsd: HIGH_BUDGET,
      maxLatencyMs: HIGH_LATENCY,
    });
    expect(out).toEqual([]);
  });

  it('4. two adapters (one TEE, one not), teeRequired=true → only TEE providers', async () => {
    const teeA = makeAdapter('zg', true, [p('zg:1', 'zg', true, 0.01, 1500)]);
    const x = makeAdapter('x402', false, [p('x402:1', 'x402', false, 0.001, 200)]);
    const pool = createPool([teeA, x]);
    const out = await pool.query({
      teeRequired: true,
      maxCostUsd: HIGH_BUDGET,
      maxLatencyMs: HIGH_LATENCY,
    });
    expect(out.map((q) => q.id)).toEqual(['zg:1']);
  });

  it('5. two adapters, teeRequired=false → all providers, sorted by price', async () => {
    const teeA = makeAdapter('zg', true, [p('zg:1', 'zg', true, 0.01, 1500)]);
    const x = makeAdapter('x402', false, [
      p('x402:cheap', 'x402', false, 0.001, 200),
      p('x402:mid', 'x402', false, 0.005, 400),
    ]);
    const pool = createPool([teeA, x]);
    const out = await pool.query({
      teeRequired: false,
      maxCostUsd: HIGH_BUDGET,
      maxLatencyMs: HIGH_LATENCY,
    });
    expect(out.map((q) => q.id)).toEqual(['x402:cheap', 'x402:mid', 'zg:1']);
  });

  it('6. maxCostUsd filter applied even if adapter returns over-budget item', async () => {
    const a = makeAdapter('x402', false, [
      p('x402:cheap', 'x402', false, 0.001, 200),
      p('x402:over', 'x402', false, 5.0, 200),
    ]);
    const pool = createPool([a]);
    const out = await pool.query({
      teeRequired: false,
      maxCostUsd: 0.01,
      maxLatencyMs: HIGH_LATENCY,
    });
    expect(out.map((q) => q.id)).toEqual(['x402:cheap']);
  });

  it('7. maxLatencyMs filter applied even if adapter returns slow item', async () => {
    const a = makeAdapter('x402', false, [
      p('x402:fast', 'x402', false, 0.001, 200),
      p('x402:slow', 'x402', false, 0.001, 99_999),
    ]);
    const pool = createPool([a]);
    const out = await pool.query({
      teeRequired: false,
      maxCostUsd: HIGH_BUDGET,
      maxLatencyMs: 1_000,
    });
    expect(out.map((q) => q.id)).toEqual(['x402:fast']);
  });

  it('8. sort tie-break by latency, then by id', async () => {
    const a = makeAdapter('x402', false, [
      p('x402:c', 'x402', false, 0.001, 300),
      p('x402:a', 'x402', false, 0.001, 300),
      p('x402:b', 'x402', false, 0.001, 200),
      p('x402:d', 'x402', false, 0.002, 100),
    ]);
    const pool = createPool([a]);
    const out = await pool.query({
      teeRequired: false,
      maxCostUsd: HIGH_BUDGET,
      maxLatencyMs: HIGH_LATENCY,
    });
    // price 0.001 group: latency 200 (b) < 300 → among 300s, id a < c.
    // then price 0.002 (d).
    expect(out.map((q) => q.id)).toEqual(['x402:b', 'x402:a', 'x402:c', 'x402:d']);
  });

  it('9. count=3 returns top 3 by price', async () => {
    const a = makeAdapter('x402', false, [
      p('x402:1', 'x402', false, 0.001, 200),
      p('x402:2', 'x402', false, 0.002, 200),
      p('x402:3', 'x402', false, 0.003, 200),
      p('x402:4', 'x402', false, 0.004, 200),
      p('x402:5', 'x402', false, 0.005, 200),
    ]);
    const pool = createPool([a]);
    const out = await pool.query({
      teeRequired: false,
      maxCostUsd: HIGH_BUDGET,
      maxLatencyMs: HIGH_LATENCY,
      count: 3,
    });
    expect(out.map((q) => q.id)).toEqual(['x402:1', 'x402:2', 'x402:3']);
  });

  it('10. count=5 but only 2 available → returns 2 (no padding, no error)', async () => {
    const a = makeAdapter('x402', false, [
      p('x402:1', 'x402', false, 0.001, 200),
      p('x402:2', 'x402', false, 0.002, 200),
    ]);
    const pool = createPool([a]);
    const out = await pool.query({
      teeRequired: false,
      maxCostUsd: HIGH_BUDGET,
      maxLatencyMs: HIGH_LATENCY,
      count: 5,
    });
    expect(out.map((q) => q.id)).toEqual(['x402:1', 'x402:2']);
  });

  it('11. requireOneTee=true with 3 cheap non-TEE + 1 expensive TEE, count=3 → swaps in TEE', async () => {
    const x = makeAdapter('x402', false, [
      p('x402:1', 'x402', false, 0.001, 200),
      p('x402:2', 'x402', false, 0.002, 200),
      p('x402:3', 'x402', false, 0.003, 200),
    ]);
    const z = makeAdapter('zg', true, [p('zg:tee', 'zg', true, 0.05, 1500)]);
    const pool = createPool([x, z]);
    const out = await pool.query({
      teeRequired: false,
      maxCostUsd: HIGH_BUDGET,
      maxLatencyMs: HIGH_LATENCY,
      count: 3,
      requireOneTee: true,
    });
    const ids = out.map((q) => q.id);
    expect(ids.length).toBe(3);
    expect(ids).toContain('zg:tee');
    // The most expensive non-TEE in the top-N (x402:3) should be swapped out.
    expect(ids).not.toContain('x402:3');
    expect(ids).toContain('x402:1');
    expect(ids).toContain('x402:2');
  });

  it('12. requireOneTee=true when top 3 already includes a TEE → no swap needed', async () => {
    const z = makeAdapter('zg', true, [p('zg:tee', 'zg', true, 0.0005, 1500)]);
    const x = makeAdapter('x402', false, [
      p('x402:1', 'x402', false, 0.001, 200),
      p('x402:2', 'x402', false, 0.002, 200),
      p('x402:3', 'x402', false, 0.003, 200),
    ]);
    const pool = createPool([z, x]);
    const out = await pool.query({
      teeRequired: false,
      maxCostUsd: HIGH_BUDGET,
      maxLatencyMs: HIGH_LATENCY,
      count: 3,
      requireOneTee: true,
    });
    expect(out.map((q) => q.id)).toEqual(['zg:tee', 'x402:1', 'x402:2']);
  });

  it('13. requireOneTee=true when no TEE provider exists → returns top 3 non-TEE (best effort)', async () => {
    const x = makeAdapter('x402', false, [
      p('x402:1', 'x402', false, 0.001, 200),
      p('x402:2', 'x402', false, 0.002, 200),
      p('x402:3', 'x402', false, 0.003, 200),
      p('x402:4', 'x402', false, 0.004, 200),
    ]);
    const pool = createPool([x]);
    const out = await pool.query({
      teeRequired: false,
      maxCostUsd: HIGH_BUDGET,
      maxLatencyMs: HIGH_LATENCY,
      count: 3,
      requireOneTee: true,
    });
    expect(out.map((q) => q.id)).toEqual(['x402:1', 'x402:2', 'x402:3']);
  });

  it('14. adapters called in parallel (timing assertion)', async () => {
    const slowA = makeAdapter(
      'zg',
      true,
      [p('zg:1', 'zg', true, 0.01, 1500)],
      { delayMs: 100 },
    );
    const slowB = makeAdapter(
      'x402',
      false,
      [p('x402:1', 'x402', false, 0.001, 200)],
      { delayMs: 100 },
    );
    const pool = createPool([slowA, slowB]);
    const t0 = Date.now();
    const out = await pool.query({
      teeRequired: false,
      maxCostUsd: HIGH_BUDGET,
      maxLatencyMs: HIGH_LATENCY,
    });
    const elapsed = Date.now() - t0;
    expect(out.length).toBe(2);
    // Sequential would be ~200ms; parallel ~100ms. Allow generous slack.
    expect(elapsed).toBeLessThan(180);
  });

  it('15. adapter that throws → treated as empty (does not propagate)', async () => {
    const broken = makeAdapter('zg', true, [], { throws: true });
    const ok = makeAdapter('x402', false, [p('x402:1', 'x402', false, 0.001, 200)]);
    const pool = createPool([broken, ok]);
    const out = await pool.query({
      teeRequired: false,
      maxCostUsd: HIGH_BUDGET,
      maxLatencyMs: HIGH_LATENCY,
    });
    expect(out.map((q) => q.id)).toEqual(['x402:1']);
  });

  it('requireOneTee with count=undefined is ignored (returns full sorted list)', async () => {
    const x = makeAdapter('x402', false, [
      p('x402:1', 'x402', false, 0.001, 200),
      p('x402:2', 'x402', false, 0.002, 200),
    ]);
    const pool = createPool([x]);
    const out = await pool.query({
      teeRequired: false,
      maxCostUsd: HIGH_BUDGET,
      maxLatencyMs: HIGH_LATENCY,
      requireOneTee: true,
    });
    expect(out.map((q) => q.id)).toEqual(['x402:1', 'x402:2']);
  });
});
