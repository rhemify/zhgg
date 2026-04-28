import { describe, it, expect } from 'bun:test';
import {
  scoreAgreement,
  CONSENSUS_THRESHOLD,
} from '../src/consensus.js';
import type { InferenceResult } from '../src/intent.js';

function makeResult(response: string): InferenceResult {
  return {
    response,
    cost_usd: 0,
    latency_ms: 0,
    attestation_root: null,
    receipt: '',
    provider_id: 'test',
  };
}

const m = (...responses: string[]): InferenceResult[] =>
  responses.map(makeResult);

describe('scoreAgreement: empty input', () => {
  it('returns zero score and low_confidence on empty results', () => {
    const r = scoreAgreement([], 'categorical');
    expect(r.agreement_score).toBe(0);
    expect(r.consensus_response).toBe('');
    expect(r.outliers).toEqual([]);
    expect(r.low_confidence).toBe(true);
  });
});

describe('scoreAgreement: categorical', () => {
  it('all agree => score 1.0, no outliers', () => {
    const r = scoreAgreement(m('bullish', 'bullish', 'bullish'), 'categorical');
    expect(r.agreement_score).toBe(1);
    expect(r.consensus_response).toBe('bullish');
    expect(r.outliers).toEqual([]);
    expect(r.low_confidence).toBe(false);
  });

  it('2/3 agree => score ~0.667 with 1 outlier', () => {
    const r = scoreAgreement(
      m('bullish', 'bullish', 'bearish'),
      'categorical',
    );
    expect(r.agreement_score).toBeCloseTo(2 / 3, 5);
    expect(r.consensus_response).toBe('bullish');
    expect(r.outliers).toEqual(['bearish']);
    expect(r.low_confidence).toBe(true);
  });

  it('all disagree (1-1-1) => score 1/3, deterministic lex-first winner', () => {
    const r = scoreAgreement(
      m('neutral', 'bullish', 'bearish'),
      'categorical',
    );
    expect(r.agreement_score).toBeCloseTo(1 / 3, 5);
    // Lex-first among bearish | bullish | neutral => bearish.
    expect(r.consensus_response).toBe('bearish');
    expect(r.outliers).toContain('neutral');
    expect(r.outliers).toContain('bullish');
    expect(r.low_confidence).toBe(true);
  });

  it('case-insensitive match: Bullish / BULLISH / bullish => all same', () => {
    const r = scoreAgreement(
      m('Bullish', 'BULLISH', 'bullish'),
      'categorical',
    );
    expect(r.agreement_score).toBe(1);
    // First original is preserved in consensus_response.
    expect(r.consensus_response).toBe('Bullish');
    expect(r.outliers).toEqual([]);
  });

  it('whitespace ignored: " bullish " / "bullish" => same', () => {
    const r = scoreAgreement(m(' bullish ', 'bullish'), 'categorical');
    expect(r.agreement_score).toBe(1);
    expect(r.outliers).toEqual([]);
  });

  it('tie 2-2 => deterministic lex-first winner', () => {
    const r = scoreAgreement(
      m('bullish', 'bearish', 'bullish', 'bearish'),
      'categorical',
    );
    expect(r.agreement_score).toBe(0.5);
    expect(r.consensus_response).toBe('bearish');
  });
});

describe('scoreAgreement: freeform', () => {
  it('identical responses => score 1.0', () => {
    const r = scoreAgreement(
      m(
        'the market is bullish today',
        'the market is bullish today',
        'the market is bullish today',
      ),
      'freeform',
    );
    expect(r.agreement_score).toBe(1);
    expect(r.outliers).toEqual([]);
  });

  it('completely disjoint vocabularies => low score (< 0.3)', () => {
    const r = scoreAgreement(
      m(
        'apples bananas cherries dates elderberries',
        'wolves foxes bears coyotes badgers',
      ),
      'freeform',
    );
    expect(r.agreement_score).toBeLessThan(0.3);
    expect(r.low_confidence).toBe(true);
  });

  it('slight rephrase => high score (> 0.5)', () => {
    const r = scoreAgreement(
      m(
        'the market is bullish today and rising fast',
        'today the market is bullish and rising fast',
        'the bullish market is rising fast today',
      ),
      'freeform',
    );
    expect(r.agreement_score).toBeGreaterThan(0.5);
  });

  it('1 result => score 1.0, no outliers', () => {
    const r = scoreAgreement(m('only one response here'), 'freeform');
    expect(r.agreement_score).toBe(1);
    expect(r.consensus_response).toBe('only one response here');
    expect(r.outliers).toEqual([]);
  });

  it('all-empty after tokenization => score 0, all outliers', () => {
    // Tokens of length < 2 are dropped. Single-letter words = empty.
    const r = scoreAgreement(m('a', 'a b', 'i'), 'freeform');
    expect(r.agreement_score).toBe(0);
    expect(r.outliers.length).toBe(3);
    expect(r.low_confidence).toBe(true);
  });
});

describe('scoreAgreement: numeric', () => {
  it('all identical numbers => score 1.0', () => {
    const r = scoreAgreement(m('100', '100', '100'), 'numeric');
    expect(r.agreement_score).toBe(1);
    expect(r.consensus_response).toBe('100');
    expect(r.outliers).toEqual([]);
  });

  it('3 close numbers (100, 101, 102) => high score, no outliers', () => {
    const r = scoreAgreement(m('100', '101', '102'), 'numeric');
    expect(r.agreement_score).toBeGreaterThan(0.95);
    expect(r.outliers).toEqual([]);
    expect(Number(r.consensus_response)).toBeCloseTo(101, 5);
  });

  it('1 wild outlier (100, 101, 1000) => outlier flagged, consensus close to 100.5', () => {
    const r = scoreAgreement(m('100', '101', '1000'), 'numeric');
    expect(r.outliers).toContain('1000');
    expect(Number(r.consensus_response)).toBeCloseTo(100.5, 1);
  });

  it('all NaN => score 0, all outliers', () => {
    const r = scoreAgreement(m('abc', 'xyz', 'foo'), 'numeric');
    expect(r.agreement_score).toBe(0);
    expect(r.consensus_response).toBe('');
    expect(r.outliers.length).toBe(3);
  });

  it('mixed valid + NaN ("100","200","abc") => abc outlier, consensus = mean of valid', () => {
    const r = scoreAgreement(m('100', '200', 'abc'), 'numeric');
    expect(r.outliers).toContain('abc');
    expect(Number(r.consensus_response)).toBeCloseTo(150, 5);
  });

  it('1 numeric result => score 1.0, no outliers', () => {
    const r = scoreAgreement(m('42'), 'numeric');
    expect(r.agreement_score).toBe(1);
    expect(r.consensus_response).toBe('42');
    expect(r.outliers).toEqual([]);
  });
});

describe('scoreAgreement: json', () => {
  it('all identical objects => score 1.0', () => {
    const r = scoreAgreement(
      m(
        '{"vote":"yes","weight":1}',
        '{"vote":"yes","weight":1}',
        '{"vote":"yes","weight":1}',
      ),
      'json',
    );
    expect(r.agreement_score).toBe(1);
    expect(r.outliers).toEqual([]);
  });

  it('field disagreement (1 differs on vote) => partial agreement', () => {
    const r = scoreAgreement(
      m(
        '{"vote":"yes","weight":1}',
        '{"vote":"yes","weight":1}',
        '{"vote":"no","weight":1}',
      ),
      'json',
    );
    // weight: 3/3 agree (1.0), vote: 2/3 agree (0.667). avg = ~0.833
    expect(r.agreement_score).toBeGreaterThan(0.8);
    expect(r.agreement_score).toBeLessThan(0.9);
  });

  it('1 unparseable => that one is an outlier', () => {
    const r = scoreAgreement(
      m('{"a":1}', '{"a":1}', 'NOT JSON'),
      'json',
    );
    expect(r.outliers).toContain('NOT JSON');
  });

  it('all-empty objects {} => score 1.0', () => {
    const r = scoreAgreement(m('{}', '{}', '{}'), 'json');
    expect(r.agreement_score).toBe(1);
    expect(r.consensus_response).toBe('{}');
  });

  it('nested object identical => score 1.0 (deep equality)', () => {
    const r = scoreAgreement(
      m(
        '{"a":{"b":[1,2,3],"c":{"d":"e"}}}',
        '{"a":{"b":[1,2,3],"c":{"d":"e"}}}',
      ),
      'json',
    );
    expect(r.agreement_score).toBe(1);
    expect(r.outliers).toEqual([]);
  });

  it('key order should not matter (canonicalization)', () => {
    const r = scoreAgreement(
      m('{"a":1,"b":2}', '{"b":2,"a":1}'),
      'json',
    );
    expect(r.agreement_score).toBe(1);
    expect(r.outliers).toEqual([]);
  });

  it('1 result => score 1.0, no outliers', () => {
    const r = scoreAgreement(m('{"x":42}'), 'json');
    expect(r.agreement_score).toBe(1);
    expect(r.consensus_response).toBe('{"x":42}');
    expect(r.outliers).toEqual([]);
  });
});

describe('scoreAgreement: low_confidence threshold', () => {
  it('score 0.7 exactly => low_confidence false (boundary inclusive: >= threshold)', () => {
    // 7/10 categorical = 0.7
    const seven = Array.from({ length: 7 }, () => 'yes');
    const three = Array.from({ length: 3 }, () => 'no');
    const r = scoreAgreement(m(...seven, ...three), 'categorical');
    expect(r.agreement_score).toBeCloseTo(0.7, 10);
    expect(r.low_confidence).toBe(false);
  });

  it('score 0.69 (just below 0.7) => low_confidence true', () => {
    // 69/100 categorical = 0.69
    const yes = Array.from({ length: 69 }, () => 'yes');
    const no = Array.from({ length: 31 }, () => 'no');
    const r = scoreAgreement(m(...yes, ...no), 'categorical');
    expect(r.agreement_score).toBeCloseTo(0.69, 10);
    expect(r.low_confidence).toBe(true);
  });

  it('CONSENSUS_THRESHOLD constant is 0.70', () => {
    expect(CONSENSUS_THRESHOLD).toBe(0.7);
  });
});
