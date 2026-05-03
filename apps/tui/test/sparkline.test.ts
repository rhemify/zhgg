/// Pure tests for the sparkline + trend + apyTrendHint helpers used by
/// the `park` parser's inline pre-Enter hint. The hint is the operator's
/// only pre-decision data: is the APY a peak, a trough, or stable.

import { describe, it, expect } from 'bun:test';
import {
  sparkline,
  trend,
  apyTrendHint,
  DEMO_APY_SAMPLES_30D,
  DEMO_APY_PCT,
} from '../src/sparkline.js';

describe('sparkline', () => {
  it('empty input returns empty string', () => {
    expect(sparkline([])).toBe('');
  });

  it('single value returns one block', () => {
    const r = sparkline([5]);
    expect(r.length).toBe(1);
  });

  it('flat series uses the mid block (no divide-by-zero)', () => {
    expect(sparkline([3, 3, 3, 3])).toBe('▅▅▅▅');
  });

  it('monotonic climb produces ascending block heights', () => {
    const r = sparkline([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.length).toBe(8);
    // First glyph is the lowest block, last is the highest
    expect(r[0]).toBe('▁');
    expect(r[r.length - 1]).toBe('█');
  });

  it('handles fractional APY-shaped values', () => {
    const r = sparkline([4.92, 5.05, 5.34]);
    expect(r.length).toBe(3);
  });
});

describe('trend', () => {
  it('flat for fewer than 4 samples', () => {
    expect(trend([5, 5])).toBe('flat');
  });

  it('rising series → up', () => {
    expect(trend([4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5])).toBe('up');
  });

  it('falling series → down', () => {
    expect(trend([6.0, 5.5, 5.0, 4.5, 4.0, 3.5, 3.0, 2.5])).toBe('down');
  });

  it('flat-with-noise → flat (delta within ±2%)', () => {
    expect(trend([5.0, 5.05, 4.95, 5.0, 5.02, 5.01, 4.99, 5.0])).toBe('flat');
  });

  it('demo APY samples (4.92 → 5.34) trend up', () => {
    expect(trend(DEMO_APY_SAMPLES_30D)).toBe('up');
  });
});

describe('apyTrendHint', () => {
  it('shape matches the brief — verdict line with apy + window + arrow + verb', () => {
    const hint = apyTrendHint({
      vaultLabel: 'MockERC4626',
      apyPct: DEMO_APY_PCT,
      samples: DEMO_APY_SAMPLES_30D,
    });
    expect(hint).toMatch(/^▸ MockERC4626 · APY 5\.34%/);
    expect(hint).toMatch(/30d [▁▂▃▄▅▆▇█]+/);
    expect(hint).toMatch(/↗ trending up$/);
  });

  it('zero samples skips the window block', () => {
    const hint = apyTrendHint({ vaultLabel: 'V', apyPct: 0, samples: [] });
    expect(hint).toMatch(/^▸ V · APY 0\.00% → flat$/);
  });

  it('falling samples produce ↘ trending down', () => {
    const hint = apyTrendHint({
      vaultLabel: 'V',
      apyPct: 2.0,
      samples: [6, 5.5, 5, 4.5, 4, 3.5, 3, 2.5, 2.0],
    });
    expect(hint).toMatch(/↘ trending down$/);
  });
});
