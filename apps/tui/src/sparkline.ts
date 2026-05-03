/// Inline sparkline + APY trend hint for the `park` parser. Pure
/// derivation — given a series of APY samples (most-recent last),
/// produce the unicode-block sparkline plus a one-word trend verb that
/// answers the operator's pre-Enter question: "is this a peak, a
/// trough, or a stable plateau?"
///
/// The samples themselves are intentionally not fetched here — this
/// module is pure for testability. The TUI's hint path supplies them
/// (static demo data today; an indexer call wired against the vault's
/// `previewRedeem(1e18 shares)` ratio over the past N blocks tomorrow).

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/// Render `values` as a unicode-block sparkline. Empty input → empty
/// string. Min/max of the input map to the lowest/highest block; a flat
/// series renders as the middle block to avoid divide-by-zero artefacts.
export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return '';
  let min = values[0]!;
  let max = values[0]!;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (range === 0) {
    return BLOCKS[Math.floor(BLOCKS.length / 2)]!.repeat(values.length);
  }
  return values
    .map((v) => {
      const idx = Math.min(BLOCKS.length - 1, Math.floor(((v - min) / range) * BLOCKS.length));
      return BLOCKS[idx]!;
    })
    .join('');
}

export type Trend = 'up' | 'down' | 'flat';

/// Coarse trend verdict: compare the average of the last quarter of
/// samples against the average of the first quarter. Threshold of ±2%
/// of mid-range — anything inside is `flat`. Tuned so a clear visible
/// climb/dip flips the verb but day-to-day noise doesn't.
export function trend(values: readonly number[]): Trend {
  if (values.length < 4) return 'flat';
  const q = Math.max(1, Math.floor(values.length / 4));
  const head = values.slice(0, q);
  const tail = values.slice(values.length - q);
  const avg = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const headAvg = avg(head);
  const tailAvg = avg(tail);
  const mid = (headAvg + tailAvg) / 2;
  if (mid === 0) return 'flat';
  const deltaPct = (tailAvg - headAvg) / mid;
  if (deltaPct > 0.02) return 'up';
  if (deltaPct < -0.02) return 'down';
  return 'flat';
}

const TREND_GLYPH: Record<Trend, string> = { up: '↗', down: '↘', flat: '→' };
const TREND_VERB: Record<Trend, string> = {
  up: 'trending up',
  down: 'trending down',
  flat: 'flat',
};

/// Compose the full inline hint shown before Enter:
///   `▸ MockERC4626 · APY 5.34% · 30d ▂▃▅▆▇▇█▇▆▆ ↗ trending up`
export function apyTrendHint(args: {
  vaultLabel: string;
  apyPct: number;
  samples: readonly number[];
}): string {
  const t = trend(args.samples);
  const spark = sparkline(args.samples);
  const window = args.samples.length === 0 ? '' : ` · ${args.samples.length}d ${spark}`;
  return `▸ ${args.vaultLabel} · APY ${args.apyPct.toFixed(2)}%${window} ${TREND_GLYPH[t]} ${TREND_VERB[t]}`;
}

/// Static 30-day sample series for the demo. Each value is a percent
/// APY. TODO(indexer): replace with a real fetch — read the vault's
/// `previewRedeem(1e18)` at block-heights spaced 1 day apart, convert
/// to APY, and pass into apyTrendHint. Pinned to `siewwin` for now.
export const DEMO_APY_SAMPLES_30D: readonly number[] = [
  4.92, 4.95, 5.01, 5.05, 5.07, 5.09, 5.04, 5.03, 5.06, 5.10,
  5.13, 5.14, 5.18, 5.21, 5.19, 5.16, 5.17, 5.20, 5.22, 5.25,
  5.26, 5.24, 5.27, 5.29, 5.30, 5.32, 5.33, 5.31, 5.33, 5.34,
];

export const DEMO_APY_PCT = 5.34;
