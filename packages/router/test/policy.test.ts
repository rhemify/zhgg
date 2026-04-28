import { describe, it, expect } from 'bun:test';
import type { InferenceIntent, Mode } from '../src/intent.js';
import type { ExecutionScope } from '../src/scope.js';
import {
  evaluate,
  checkSpendCap,
  checkLatencyCap,
  checkModeAllowed,
  checkNotExpired,
} from '../src/policy.js';

const NOW = 1_700_000_000_000;

function intent(overrides: Partial<InferenceIntent> = {}): InferenceIntent {
  return {
    prompt: 'test',
    mode: 'fast',
    max_cost_usd: 0.001,
    max_latency_ms: 1000,
    output_type: 'freeform',
    ...overrides,
  };
}

function scope(overrides: Partial<ExecutionScope> = {}): ExecutionScope {
  return {
    allowedModes: ['fast', 'verified', 'consensus', 'pipeline'] satisfies Mode[],
    maxCostUsd: 0.01,
    maxLatencyMs: 2000,
    ttlMs: 60_000,
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

describe('checkSpendCap', () => {
  it('allows when intent.max_cost_usd === scope.maxCostUsd (boundary)', () => {
    expect(
      checkSpendCap(intent({ max_cost_usd: 0.01 }), scope({ maxCostUsd: 0.01 })),
    ).toBeNull();
  });

  it('allows when intent.max_cost_usd < scope.maxCostUsd', () => {
    expect(
      checkSpendCap(intent({ max_cost_usd: 0.005 }), scope({ maxCostUsd: 0.01 })),
    ).toBeNull();
  });

  it('violates when intent.max_cost_usd > scope.maxCostUsd', () => {
    const v = checkSpendCap(intent({ max_cost_usd: 0.05 }), scope({ maxCostUsd: 0.01 }));
    expect(v).not.toBeNull();
    expect(v?.rule).toBe('spend_cap');
    expect(v?.reason).toContain('0.05');
    expect(v?.reason).toContain('0.01');
  });

  it('violation reason precisely contains "exceeds"', () => {
    const v = checkSpendCap(intent({ max_cost_usd: 0.05 }), scope({ maxCostUsd: 0.01 }));
    expect(v?.reason).toContain('exceeds');
  });
});

describe('checkLatencyCap', () => {
  it('allows when intent.max_latency_ms === scope.maxLatencyMs (boundary)', () => {
    expect(
      checkLatencyCap(intent({ max_latency_ms: 2000 }), scope({ maxLatencyMs: 2000 })),
    ).toBeNull();
  });

  it('allows when intent.max_latency_ms < scope.maxLatencyMs', () => {
    expect(
      checkLatencyCap(intent({ max_latency_ms: 1000 }), scope({ maxLatencyMs: 2000 })),
    ).toBeNull();
  });

  it('violates when intent.max_latency_ms > scope.maxLatencyMs', () => {
    const v = checkLatencyCap(
      intent({ max_latency_ms: 5000 }),
      scope({ maxLatencyMs: 2000 }),
    );
    expect(v).not.toBeNull();
    expect(v?.rule).toBe('latency_cap');
    expect(v?.reason).toContain('5000');
    expect(v?.reason).toContain('2000');
  });

  it('violation reason precisely contains "exceeds"', () => {
    const v = checkLatencyCap(
      intent({ max_latency_ms: 5000 }),
      scope({ maxLatencyMs: 2000 }),
    );
    expect(v?.reason).toContain('exceeds');
  });
});

describe('checkModeAllowed', () => {
  it('allows when intent.mode is in scope.allowedModes', () => {
    expect(
      checkModeAllowed(intent({ mode: 'fast' }), scope({ allowedModes: ['fast', 'verified'] })),
    ).toBeNull();
  });

  it('violates when intent.mode is not in scope.allowedModes', () => {
    const v = checkModeAllowed(
      intent({ mode: 'consensus' }),
      scope({ allowedModes: ['fast', 'verified'] }),
    );
    expect(v).not.toBeNull();
    expect(v?.rule).toBe('mode_allowed');
  });

  it('empty allowedModes array causes every mode to violate', () => {
    for (const m of ['fast', 'verified', 'consensus', 'pipeline'] as Mode[]) {
      const v = checkModeAllowed(intent({ mode: m }), scope({ allowedModes: [] }));
      expect(v).not.toBeNull();
      expect(v?.rule).toBe('mode_allowed');
    }
  });

  it('single-mode allowedModes — only that mode passes', () => {
    const s = scope({ allowedModes: ['verified'] });
    expect(checkModeAllowed(intent({ mode: 'verified' }), s)).toBeNull();
    expect(checkModeAllowed(intent({ mode: 'fast' }), s)).not.toBeNull();
    expect(checkModeAllowed(intent({ mode: 'consensus' }), s)).not.toBeNull();
    expect(checkModeAllowed(intent({ mode: 'pipeline' }), s)).not.toBeNull();
  });

  it('violation reason includes mode name and allowed list', () => {
    const v = checkModeAllowed(
      intent({ mode: 'consensus' }),
      scope({ allowedModes: ['fast', 'verified'] }),
    );
    expect(v?.reason).toContain('consensus');
    expect(v?.reason).toContain('fast');
    expect(v?.reason).toContain('verified');
  });
});

describe('checkNotExpired', () => {
  it('allows when expiresAt > now', () => {
    expect(checkNotExpired(scope({ expiresAt: NOW + 1000 }), NOW)).toBeNull();
  });

  it('violates when expiresAt === now (uses >=)', () => {
    const v = checkNotExpired(scope({ expiresAt: NOW }), NOW);
    expect(v).not.toBeNull();
    expect(v?.rule).toBe('not_expired');
  });

  it('violates when expiresAt < now', () => {
    const v = checkNotExpired(scope({ expiresAt: NOW - 1000 }), NOW);
    expect(v).not.toBeNull();
    expect(v?.rule).toBe('not_expired');
  });

  it('violation reason includes both timestamps as ISO strings', () => {
    const expiresAt = NOW - 1000;
    const v = checkNotExpired(scope({ expiresAt }), NOW);
    expect(v?.reason).toContain(new Date(expiresAt).toISOString());
    expect(v?.reason).toContain(new Date(NOW).toISOString());
  });
});

describe('evaluate', () => {
  it('returns { allowed: true } when all rules pass', () => {
    const r = evaluate(intent(), scope(), NOW);
    expect(r.allowed).toBe(true);
  });

  it('reports a single violation when only one rule fails', () => {
    const r = evaluate(intent({ max_cost_usd: 0.5 }), scope({ maxCostUsd: 0.01 }), NOW);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.violations).toHaveLength(1);
      expect(r.violations[0]?.rule).toBe('spend_cap');
    }
  });

  it('reports multiple violations when several rules fail (no short-circuit)', () => {
    const r = evaluate(
      intent({ max_cost_usd: 0.5, mode: 'consensus' }),
      scope({ maxCostUsd: 0.01, allowedModes: ['fast'] }),
      NOW,
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      const rules = r.violations.map((v) => v.rule);
      expect(rules).toContain('spend_cap');
      expect(rules).toContain('mode_allowed');
    }
  });

  it('reports all four violations in declaration order', () => {
    const r = evaluate(
      intent({
        max_cost_usd: 0.5,
        max_latency_ms: 10_000,
        mode: 'consensus',
      }),
      scope({
        maxCostUsd: 0.01,
        maxLatencyMs: 2000,
        allowedModes: ['fast'],
        expiresAt: NOW - 1,
      }),
      NOW,
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.violations.map((v) => v.rule)).toEqual([
        'spend_cap',
        'latency_cap',
        'mode_allowed',
        'not_expired',
      ]);
    }
  });

  it('respects custom now injection', () => {
    // Scope expires at NOW + 1000. With injected now < expiresAt, allowed.
    const s = scope({ expiresAt: NOW + 1000 });
    expect(evaluate(intent(), s, NOW).allowed).toBe(true);
    // With injected now > expiresAt, not_expired violation fires.
    const r = evaluate(intent(), s, NOW + 5000);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.violations.map((v) => v.rule)).toContain('not_expired');
    }
  });
});
