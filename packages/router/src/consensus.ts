import type { OutputType, InferenceResult } from './intent.js';

export interface ConsensusScore {
  agreement_score: number;
  consensus_response: string;
  outliers: string[];
  low_confidence: boolean;
}

export const CONSENSUS_THRESHOLD = 0.7;

const MIN_TOKEN_LENGTH = 2;
const NUMERIC_OUTLIER_SD_MULTIPLE = 1.5;
const NUMERIC_DECIMAL_PLACES = 6;

export function scoreAgreement(
  results: readonly InferenceResult[],
  output_type: OutputType,
): ConsensusScore {
  if (results.length === 0) {
    return {
      agreement_score: 0,
      consensus_response: '',
      outliers: [],
      low_confidence: true,
    };
  }

  switch (output_type) {
    case 'categorical':
      return finalize(scoreCategorical(results));
    case 'freeform':
      return finalize(scoreFreeform(results));
    case 'numeric':
      return finalize(scoreNumeric(results));
    case 'json':
      return finalize(scoreJson(results));
  }
}

function finalize(s: Omit<ConsensusScore, 'low_confidence'>): ConsensusScore {
  return { ...s, low_confidence: s.agreement_score < CONSENSUS_THRESHOLD };
}

// ---------- categorical ----------

function scoreCategorical(
  results: readonly InferenceResult[],
): Omit<ConsensusScore, 'low_confidence'> {
  const total = results.length;
  const normalized = results.map((r) => r.response.trim().toLowerCase());
  const counts = new Map<string, number>();
  for (const n of normalized) counts.set(n, (counts.get(n) ?? 0) + 1);

  // Determine winner: highest count, ties broken lexicographically (smallest first).
  let winner = '';
  let topCount = -1;
  // Sort keys for deterministic tie-break.
  const keys = [...counts.keys()].sort();
  for (const key of keys) {
    const c = counts.get(key) ?? 0;
    if (c > topCount) {
      topCount = c;
      winner = key;
    }
  }

  const winnerIdx = normalized.findIndex((n) => n === winner);
  const consensus_response = winnerIdx >= 0 ? results[winnerIdx]!.response : '';

  const outliers: string[] = [];
  for (let i = 0; i < total; i++) {
    if (normalized[i] !== winner) outliers.push(results[i]!.response);
  }

  const agreement_score = total > 0 ? topCount / total : 0;
  return { agreement_score, consensus_response, outliers };
}

// ---------- freeform ----------

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter((t) => t.length >= MIN_TOKEN_LENGTH);
}

function scoreFreeform(
  results: readonly InferenceResult[],
): Omit<ConsensusScore, 'low_confidence'> {
  const total = results.length;

  if (total === 1) {
    return {
      agreement_score: 1,
      consensus_response: results[0]!.response,
      outliers: [],
    };
  }

  const tokens: string[][] = results.map((r) => tokenize(r.response));
  const allEmpty = tokens.every((t) => t.length === 0);
  if (allEmpty) {
    return {
      agreement_score: 0,
      consensus_response: results[0]!.response,
      outliers: results.map((r) => r.response),
    };
  }

  // TF: per response.
  const tfs: Map<string, number>[] = tokens.map((toks) => {
    const m = new Map<string, number>();
    for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  });

  // IDF across documents. Use ln((N + 1) / (df + 1)) + 1 for smoothing,
  // safe against zero division and zero IDF for ubiquitous terms.
  const df = new Map<string, number>();
  for (const tf of tfs) {
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [term, frequency] of df.entries()) {
    idf.set(term, Math.log((total + 1) / (frequency + 1)) + 1);
  }

  // TF-IDF vectors.
  const vectors: Map<string, number>[] = tfs.map((tf) => {
    const v = new Map<string, number>();
    for (const [term, count] of tf.entries()) {
      const w = (idf.get(term) ?? 0) * count;
      if (w !== 0) v.set(term, w);
    }
    return v;
  });

  // Cosine similarity (i, j).
  const sim = (i: number, j: number): number => {
    const a = vectors[i]!;
    const b = vectors[j]!;
    if (a.size === 0 || b.size === 0) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (const [, v] of a.entries()) na += v * v;
    for (const [, v] of b.entries()) nb += v * v;
    const small = a.size <= b.size ? a : b;
    const big = a.size <= b.size ? b : a;
    for (const [term, v] of small.entries()) {
      const w = big.get(term);
      if (w !== undefined) dot += v * w;
    }
    if (na === 0 || nb === 0) return 0;
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    if (!Number.isFinite(denom) || denom === 0) return 0;
    const cos = dot / denom;
    // Clamp tiny floating-point overshoots so identical vectors return exactly 1.
    if (cos > 1) return 1;
    if (cos < 0) return 0;
    if (Math.abs(cos - 1) < 1e-12) return 1;
    return cos;
  };

  const sims: number[][] = Array.from({ length: total }, () =>
    Array.from({ length: total }, () => 0),
  );
  const pairwise: number[] = [];
  for (let i = 0; i < total; i++) {
    for (let j = i + 1; j < total; j++) {
      const s = sim(i, j);
      sims[i]![j] = s;
      sims[j]![i] = s;
      pairwise.push(s);
    }
  }

  // Min pairwise = pessimistic agreement.
  let minSim = Infinity;
  for (const s of pairwise) if (s < minSim) minSim = s;
  const agreement_score = Number.isFinite(minSim) ? clamp01(minSim) : 1;

  // Centroid-like: highest summed similarity to others.
  let bestIdx = 0;
  let bestSum = -Infinity;
  for (let i = 0; i < total; i++) {
    let sum = 0;
    for (let j = 0; j < total; j++) if (j !== i) sum += sims[i]![j]!;
    if (sum > bestSum) {
      bestSum = sum;
      bestIdx = i;
    }
  }
  const consensus_response = results[bestIdx]!.response;

  // Outliers: max-sim-to-any-other below median pairwise.
  const median = computeMedian(pairwise);
  const outliers: string[] = [];
  for (let i = 0; i < total; i++) {
    let maxOther = -Infinity;
    for (let j = 0; j < total; j++) {
      if (j === i) continue;
      const s = sims[i]![j]!;
      if (s > maxOther) maxOther = s;
    }
    if (Number.isFinite(maxOther) && maxOther < median) {
      outliers.push(results[i]!.response);
    }
  }

  return { agreement_score, consensus_response, outliers };
}

function computeMedian(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// ---------- numeric ----------

function scoreNumeric(
  results: readonly InferenceResult[],
): Omit<ConsensusScore, 'low_confidence'> {
  const total = results.length;
  const parsed: { idx: number; value: number; original: string }[] = [];
  const nanOutliers: string[] = [];

  for (let i = 0; i < total; i++) {
    const original = results[i]!.response;
    const value = Number(original.trim());
    if (Number.isFinite(value)) {
      parsed.push({ idx: i, value, original });
    } else {
      nanOutliers.push(original);
    }
  }

  if (parsed.length === 0) {
    return {
      agreement_score: 0,
      consensus_response: '',
      outliers: results.map((r) => r.response),
    };
  }

  if (parsed.length === 1) {
    const v = parsed[0]!.value;
    return {
      agreement_score: nanOutliers.length === 0 ? 1 : 0,
      consensus_response: formatNumber(v),
      outliers: nanOutliers,
    };
  }

  const mean =
    parsed.reduce((acc, p) => acc + p.value, 0) / parsed.length;
  const variance =
    parsed.reduce((acc, p) => acc + (p.value - mean) ** 2, 0) /
    parsed.length;
  const sd = Math.sqrt(variance);

  const sdOutliers: string[] = [];
  const inliers: number[] = [];
  if (sd === 0) {
    for (const p of parsed) inliers.push(p.value);
  } else {
    // Use a robust scale estimate (median absolute deviation) alongside the
    // SD-based check. With small N (e.g. 3) a single extreme value inflates
    // the population SD enough to mask itself; MAD is unaffected. A point is
    // flagged as outlier if it exceeds 1.5x EITHER the SD OR the MAD
    // distance from the central tendency. This satisfies the SPEC's
    // ">1.5σ flagged" rule while remaining robust for small batches.
    const sortedValues = parsed.map((p) => p.value).sort((a, b) => a - b);
    const median = computeMedian(sortedValues);
    const absDevs = sortedValues
      .map((v) => Math.abs(v - median))
      .sort((a, b) => a - b);
    const mad = computeMedian(absDevs);
    for (const p of parsed) {
      const sdDev = Math.abs(p.value - mean);
      const madDev = Math.abs(p.value - median);
      const sdFlag = sdDev > NUMERIC_OUTLIER_SD_MULTIPLE * sd;
      const madFlag = mad > 0 && madDev > NUMERIC_OUTLIER_SD_MULTIPLE * mad;
      if (sdFlag || madFlag) {
        sdOutliers.push(p.original);
      } else {
        inliers.push(p.value);
      }
    }
  }

  const inlierMean =
    inliers.length > 0
      ? inliers.reduce((a, b) => a + b, 0) / inliers.length
      : mean;

  // Compute score from inliers (post-outlier-rejection) so a single wild
  // outlier does not tank agreement among consenting responses.
  let agreement_score: number;
  if (inliers.length === 0) {
    agreement_score = 0;
  } else if (inliers.length === 1) {
    agreement_score = 1;
  } else {
    const inlierMeanForScore =
      inliers.reduce((a, b) => a + b, 0) / inliers.length;
    const inlierVar =
      inliers.reduce((acc, v) => acc + (v - inlierMeanForScore) ** 2, 0) /
      inliers.length;
    const inlierSd = Math.sqrt(inlierVar);
    if (inlierSd === 0) {
      agreement_score = 1;
    } else if (inlierMeanForScore === 0) {
      agreement_score = 0;
    } else {
      const cv = inlierSd / Math.abs(inlierMeanForScore);
      agreement_score = clamp01(1 - cv);
    }
  }

  // Penalize NaN + std-dev outliers proportionally to total responses.
  const totalOutliers = nanOutliers.length + sdOutliers.length;
  if (totalOutliers > 0 && total > 0) {
    const validRatio = (total - totalOutliers) / total;
    agreement_score = agreement_score * validRatio;
  }

  return {
    agreement_score,
    consensus_response: formatNumber(inlierMean),
    outliers: [...nanOutliers, ...sdOutliers],
  };
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '';
  // Up to NUMERIC_DECIMAL_PLACES decimals, trimming trailing zeros.
  const fixed = n.toFixed(NUMERIC_DECIMAL_PLACES);
  // Trim trailing zeros & possible trailing dot.
  return fixed.replace(/\.?0+$/, '') || '0';
}

// ---------- json ----------

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function isPlainObject(v: unknown): v is { [key: string]: JsonValue } {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((v) => canonicalize(v));
  }
  if (isPlainObject(value)) {
    const out: { [key: string]: JsonValue } = {};
    const keys = Object.keys(value).sort();
    for (const k of keys) out[k] = canonicalize(value[k] as JsonValue);
    return out;
  }
  return value;
}

function canonicalStringify(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

function scoreJson(
  results: readonly InferenceResult[],
): Omit<ConsensusScore, 'low_confidence'> {
  const total = results.length;
  const parsed: { idx: number; obj: { [key: string]: JsonValue }; original: string }[] = [];
  const parseFailures: string[] = [];

  for (let i = 0; i < total; i++) {
    const original = results[i]!.response;
    try {
      const v: unknown = JSON.parse(original);
      if (isPlainObject(v)) {
        parsed.push({ idx: i, obj: v, original });
      } else {
        parseFailures.push(original);
      }
    } catch {
      parseFailures.push(original);
    }
  }

  if (parsed.length === 0) {
    return {
      agreement_score: 0,
      consensus_response: '',
      outliers: results.map((r) => r.response),
    };
  }

  if (total === 1 && parsed.length === 1) {
    return {
      agreement_score: 1,
      consensus_response: parsed[0]!.original,
      outliers: [],
    };
  }

  const allKeys = new Set<string>();
  for (const p of parsed) for (const k of Object.keys(p.obj)) allKeys.add(k);

  if (allKeys.size === 0) {
    // All parsed objects are empty. If parse failures exist, they're outliers.
    const score = parseFailures.length === 0 ? 1 : parsed.length / total;
    return {
      agreement_score: score,
      consensus_response: '{}',
      outliers: parseFailures,
    };
  }

  // For each key, determine the most-common canonical value (ties broken by first appearance).
  const keyTopValue = new Map<string, JsonValue>();
  const keyTopCount = new Map<string, number>();
  // Track per-result, per-key whether they match the top.
  const perResultDeviations: number[] = parsed.map(() => 0);
  const perResultEvaluatedKeys: number[] = parsed.map(() => 0);

  let totalAgreement = 0;
  for (const key of allKeys) {
    const counts = new Map<string, { count: number; value: JsonValue; firstIdx: number }>();
    for (let pi = 0; pi < parsed.length; pi++) {
      const p = parsed[pi]!;
      if (!(key in p.obj)) continue;
      const v = p.obj[key] as JsonValue;
      const canonical = canonicalStringify(v);
      const existing = counts.get(canonical);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(canonical, { count: 1, value: v, firstIdx: pi });
      }
    }
    if (counts.size === 0) continue;
    let topCanonical = '';
    let top = -1;
    let topFirstIdx = Infinity;
    for (const [canonical, entry] of counts.entries()) {
      if (
        entry.count > top ||
        (entry.count === top && entry.firstIdx < topFirstIdx)
      ) {
        top = entry.count;
        topCanonical = canonical;
        topFirstIdx = entry.firstIdx;
      }
    }
    const topEntry = counts.get(topCanonical)!;
    keyTopValue.set(key, topEntry.value);
    keyTopCount.set(key, topEntry.count);
    totalAgreement += top / total;

    // Track deviations per result.
    for (let pi = 0; pi < parsed.length; pi++) {
      const p = parsed[pi]!;
      perResultEvaluatedKeys[pi] = (perResultEvaluatedKeys[pi] ?? 0) + 1;
      if (!(key in p.obj)) {
        perResultDeviations[pi] = (perResultDeviations[pi] ?? 0) + 1;
        continue;
      }
      const v = p.obj[key] as JsonValue;
      if (canonicalStringify(v) !== topCanonical) {
        perResultDeviations[pi] = (perResultDeviations[pi] ?? 0) + 1;
      }
    }
  }

  const numKeys = allKeys.size;
  const agreement_score = clamp01(totalAgreement / numKeys);

  // Build consensus object from key-top values.
  const consensusObj: { [key: string]: JsonValue } = {};
  for (const key of [...allKeys].sort()) {
    const v = keyTopValue.get(key);
    if (v !== undefined) consensusObj[key] = v;
  }
  const consensus_response = JSON.stringify(consensusObj);

  // Outliers: parse failures + any parsed result deviating on > 50% of keys.
  const outliers: string[] = [...parseFailures];
  for (let pi = 0; pi < parsed.length; pi++) {
    const evaluated = perResultEvaluatedKeys[pi] ?? 0;
    const deviated = perResultDeviations[pi] ?? 0;
    if (evaluated > 0 && deviated / evaluated > 0.5) {
      outliers.push(parsed[pi]!.original);
    }
  }

  return { agreement_score, consensus_response, outliers };
}
