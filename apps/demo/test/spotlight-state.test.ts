/// Pure reducer + derivation tests for the cinematic spotlight CLI.
/// Covers the verdict glyph/label/confidence morph as probes resolve in
/// each ordering (all pass, mixed, all fail) and through to `complete`
/// + `failed` phases. `render.ts` consumes these derivations directly.

import { describe, it, expect } from 'bun:test';
import {
  initialState,
  reduce,
  targetConfidence,
  verdictGlyph,
  verdictLabel,
  type SpotlightEvent,
} from '../src/spotlight/state.js';

const PROBE_REFS = ['Article 50', 'Article 5', 'Article 13'];

const startEv = (target = 'oracle'): SpotlightEvent => ({
  type: 'audit.start',
  target,
  probesTotal: 3,
  probeRefs: PROBE_REFS,
});

const probeEv = (ref: string, pass: boolean): SpotlightEvent => ({
  type: 'probe.complete',
  ref,
  pass,
  finding: pass ? 'compliant' : 'biometric scoring detected',
  costUsd: 0.0006,
});

describe('spotlight state — initial frame', () => {
  it('starts idle with no glyph and zero confidence', () => {
    const s = initialState('oracle', 0);
    expect(s.phase).toBe('idle');
    expect(verdictGlyph(s)).toBe(' ');
    expect(verdictLabel(s)).toBe('idle');
    expect(targetConfidence(s)).toBe(0);
  });
});

describe('spotlight state — running phase morph', () => {
  it('audit.start switches to ◯ analyzing at 30% confidence', () => {
    let s = initialState('oracle', 0);
    s = reduce(s, startEv());
    expect(s.phase).toBe('running');
    expect(verdictGlyph(s)).toBe('◯');
    expect(verdictLabel(s)).toBe('analyzing');
    expect(targetConfidence(s)).toBe(30);
    expect(s.trail.length).toBe(3);
    expect(s.trail.every((r) => r.status === 'pending')).toBe(true);
  });

  it('first probe passing morphs glyph to ◐ leaning compliant ~46%', () => {
    let s = initialState('oracle', 0);
    s = reduce(s, startEv());
    s = reduce(s, probeEv('Article 50', true));
    expect(verdictGlyph(s)).toBe('◐');
    expect(verdictLabel(s)).toBe('leaning compliant');
    // 30 + (1/3)*50 = 46.66...
    expect(targetConfidence(s)).toBeCloseTo(46.67, 1);
    expect(s.probes.passed).toBe(1);
    expect(s.trail[0]?.status).toBe('pass');
    expect(s.trail[1]?.status).toBe('pending');
  });

  it('two probes pass → confidence climbs ~63%', () => {
    let s = initialState('oracle', 0);
    s = reduce(s, startEv());
    s = reduce(s, probeEv('Article 50', true));
    s = reduce(s, probeEv('Article 5', true));
    expect(targetConfidence(s)).toBeCloseTo(63.33, 1);
  });

  it('one fail flips glyph to leaning non-compliant', () => {
    let s = initialState('oracle', 0);
    s = reduce(s, startEv());
    s = reduce(s, probeEv('Article 5', false));
    expect(verdictGlyph(s)).toBe('◐');
    expect(verdictLabel(s)).toBe('leaning non-compliant');
    // 30 + 0 - 12 (fail penalty) = 18
    expect(targetConfidence(s)).toBe(18);
  });

  it('mixed pass+fail labels mixed signal', () => {
    let s = initialState('oracle', 0);
    s = reduce(s, startEv());
    s = reduce(s, probeEv('Article 50', true));
    s = reduce(s, probeEv('Article 5', false));
    expect(verdictLabel(s)).toBe('mixed signal');
  });

  it('cost accumulates per probe', () => {
    let s = initialState('oracle', 0);
    s = reduce(s, startEv());
    s = reduce(s, probeEv('Article 50', true));
    s = reduce(s, probeEv('Article 5', true));
    expect(s.costUsd).toBeCloseTo(0.0012, 4);
  });
});

describe('spotlight state — complete phase reveal', () => {
  it('compliant verdict → ● COMPLIANT 95%', () => {
    let s = initialState('oracle', 0);
    s = reduce(s, startEv());
    PROBE_REFS.forEach((ref) => (s = reduce(s, probeEv(ref, true))));
    s = reduce(s, { type: 'audit.complete', verdict: 'compliant', findings: [] });
    expect(s.phase).toBe('complete');
    expect(verdictGlyph(s)).toBe('●');
    expect(verdictLabel(s)).toBe('COMPLIANT');
    expect(targetConfidence(s)).toBe(95);
  });

  it('non_compliant verdict → ● NON-COMPLIANT 95%', () => {
    let s = initialState('oracle', 0);
    s = reduce(s, startEv());
    s = reduce(s, probeEv('Article 5', false));
    s = reduce(s, { type: 'audit.complete', verdict: 'non_compliant', findings: [] });
    expect(verdictLabel(s)).toBe('NON-COMPLIANT');
    expect(targetConfidence(s)).toBe(95);
  });

  it('unclear verdict → 50% confidence', () => {
    let s = initialState('oracle', 0);
    s = reduce(s, startEv());
    s = reduce(s, { type: 'audit.complete', verdict: 'unclear', findings: [] });
    expect(verdictLabel(s)).toBe('UNCLEAR');
    expect(targetConfidence(s)).toBe(50);
  });

  it('proof artifacts are stored separately and only revealed in complete phase', () => {
    let s = initialState('oracle', 0);
    s = reduce(s, startEv());
    s = reduce(s, { type: 'audit.report.pin', uri: '0g://storage/0xabc', hash: '0xfeed' });
    s = reduce(s, { type: 'audit.receipt.post', txHash: '0xreceipt' });
    s = reduce(s, { type: 'oracle.payment.settle', txHash: '0xpaytx' });
    s = reduce(s, { type: 'audit.attestation', root: '0xattestation' });
    expect(s.reportUri).toBe('0g://storage/0xabc');
    expect(s.reportHash).toBe('0xfeed');
    expect(s.receiptTx).toBe('0xreceipt');
    expect(s.paymentTx).toBe('0xpaytx');
    expect(s.attestationRoot).toBe('0xattestation');
  });
});

describe('spotlight state — failure phase', () => {
  it('audit.failed flips to ✕ FAILED with reason', () => {
    let s = initialState('oracle', 0);
    s = reduce(s, startEv());
    s = reduce(s, { type: 'audit.failed', reason: '402 declined: spend cap' });
    expect(s.phase).toBe('failed');
    expect(verdictGlyph(s)).toBe('✕');
    expect(verdictLabel(s)).toBe('FAILED');
    expect(s.failureReason).toBe('402 declined: spend cap');
    expect(targetConfidence(s)).toBe(0);
  });
});
