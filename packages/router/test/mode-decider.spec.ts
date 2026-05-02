import { describe, it, expect } from 'bun:test';
import { decideMode } from '../src/mode-decider.js';

describe('decideMode — fail-open paths', () => {
  it('returns requested unchanged when classifier output is null', () => {
    const r = decideMode({ requested: 'fast', classified: null, risk: 'LOW' });
    expect(r.mode).toBe('fast');
    expect(r.overridden).toBe(false);
    expect(r.reason).toBe('classifier_unavailable');
  });

  it('returns requested unchanged when confidence is below threshold', () => {
    const r = decideMode({
      requested: 'fast',
      classified: { score: 9, recommended: 'consensus', confidence: 0.5 },
      risk: 'MEDIUM',
    });
    expect(r.mode).toBe('fast');
    expect(r.overridden).toBe(false);
    expect(r.reason).toContain('low_confidence');
  });
});

describe('decideMode — upgrade path', () => {
  it('upgrades fast → consensus when classifier scores high with confidence', () => {
    const r = decideMode({
      requested: 'fast',
      classified: { score: 9, recommended: 'consensus', confidence: 0.95 },
      risk: 'MEDIUM',
      allowUpgrade: true,
    });
    expect(r.mode).toBe('consensus');
    expect(r.overridden).toBe(true);
    expect(r.reason).toContain('upgrade');
  });

  it('does NOT upgrade when allowUpgrade is false', () => {
    const r = decideMode({
      requested: 'fast',
      classified: { score: 9, recommended: 'consensus', confidence: 0.95 },
      risk: 'MEDIUM',
      allowUpgrade: false,
    });
    expect(r.mode).toBe('fast');
    expect(r.overridden).toBe(false);
    expect(r.reason).toBe('upgrade_disallowed');
  });

  it('upgrades CRITICAL intents even at the user-requested tier mismatch', () => {
    const r = decideMode({
      requested: 'fast',
      classified: { score: 8, recommended: 'consensus', confidence: 0.85 },
      risk: 'CRITICAL',
    });
    expect(r.mode).toBe('consensus');
    expect(r.overridden).toBe(true);
    expect(r.reason).toContain('critical');
  });
});

describe('decideMode — downgrade path', () => {
  it('refuses to downgrade by default (allowDowngrade omitted)', () => {
    const r = decideMode({
      requested: 'consensus',
      classified: { score: 1, recommended: 'fast', confidence: 0.95 },
      risk: 'LOW',
    });
    expect(r.mode).toBe('consensus');
    expect(r.reason).toBe('downgrade_disallowed');
  });

  it('downgrades only when allowDowngrade=true AND score is trivial', () => {
    const r = decideMode({
      requested: 'consensus',
      classified: { score: 2, recommended: 'fast', confidence: 0.9 },
      risk: 'LOW',
      allowDowngrade: true,
    });
    expect(r.mode).toBe('fast');
    expect(r.overridden).toBe(true);
    expect(r.reason).toContain('downgrade');
  });

  it('refuses to downgrade if score is above the trivial threshold', () => {
    const r = decideMode({
      requested: 'consensus',
      classified: { score: 5, recommended: 'verified', confidence: 0.95 },
      risk: 'LOW',
      allowDowngrade: true,
    });
    expect(r.mode).toBe('consensus');
    expect(r.reason).toContain('downgrade_score_too_high');
  });

  it('NEVER downgrades CRITICAL intents regardless of permissions', () => {
    const r = decideMode({
      requested: 'consensus',
      classified: { score: 1, recommended: 'fast', confidence: 0.99 },
      risk: 'CRITICAL',
      allowDowngrade: true, // even when explicitly allowed
    });
    expect(r.mode).toBe('consensus');
    expect(r.overridden).toBe(false);
    expect(r.reason).toBe('no_change_critical');
  });
});

describe('decideMode — same-tier no-op', () => {
  it('returns unchanged when requested === recommended', () => {
    const r = decideMode({
      requested: 'verified',
      classified: { score: 5, recommended: 'verified', confidence: 0.9 },
      risk: 'MEDIUM',
    });
    expect(r.mode).toBe('verified');
    expect(r.overridden).toBe(false);
    expect(r.reason).toBe('no_change');
  });
});
