import { describe, it, expect } from 'bun:test';
import {
  createScope,
  signScope,
  verifyScope,
  narrowScope,
  type ExecutionScope,
} from '../src/scope.js';

describe('ExecutionScope', () => {
  const base: ExecutionScope = {
    allowedModes: ['fast', 'verified', 'consensus', 'pipeline'],
    maxCostUsd: 0.01,
    maxLatencyMs: 2000,
    ttlMs: 60_000,
    expiresAt: Date.now() + 60_000,
  };

  it('createScope sets expiresAt from ttlMs', () => {
    const before = Date.now();
    const scope = createScope({
      allowedModes: ['fast'],
      maxCostUsd: 0.01,
      maxLatencyMs: 2000,
      ttlMs: 30_000,
    });
    const after = Date.now();
    expect(scope.expiresAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(scope.expiresAt).toBeLessThanOrEqual(after + 30_000);
  });

  it('sign and verify round-trips correctly', () => {
    const token = signScope(base, 'test-secret');
    const result = verifyScope(token, 'test-secret');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.maxCostUsd).toBe(base.maxCostUsd);
      expect(result.value.allowedModes).toEqual(base.allowedModes);
    }
  });

  it('verify fails with wrong secret', () => {
    const token = signScope(base, 'correct-secret');
    const result = verifyScope(token, 'wrong-secret');
    expect(result.ok).toBe(false);
  });

  it('verify fails on expired token (past expiresAt)', () => {
    const expired: ExecutionScope = { ...base, expiresAt: Date.now() - 1 };
    const token = signScope(expired, 'test-secret');
    const result = verifyScope(token, 'test-secret');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('expired');
  });

  it('verify fails on expired token (expiresAt === now)', () => {
    const atBoundary: ExecutionScope = { ...base, expiresAt: Date.now() };
    const token = signScope(atBoundary, 'test-secret');
    const result = verifyScope(token, 'test-secret');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('expired');
  });

  it('verify fails after sleep past expiresAt', async () => {
    const shortLived: ExecutionScope = { ...base, expiresAt: Date.now() + 50 };
    const token = signScope(shortLived, 'test-secret');
    await new Promise((r) => setTimeout(r, 100));
    const result = verifyScope(token, 'test-secret');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('expired');
  });

  it('verify fails on tampered payload', () => {
    const token = signScope(base, 'test-secret');
    const [payload, sig] = token.split('.');
    const tampered =
      Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(payload!, 'base64url').toString()),
          maxCostUsd: 999,
        }),
      ).toString('base64url') +
      '.' +
      sig;
    const result = verifyScope(tampered, 'test-secret');
    expect(result.ok).toBe(false);
  });

  it('verify fails on token with no dot', () => {
    const result = verifyScope('not-a-valid-token', 'test-secret');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('malformed');
  });

  it('verify fails on empty token', () => {
    expect(verifyScope('', 'test-secret').ok).toBe(false);
  });

  it('verify fails on lone dot', () => {
    expect(verifyScope('.', 'test-secret').ok).toBe(false);
  });

  it('verify fails on token with payload but missing signature', () => {
    expect(verifyScope('payload.', 'test-secret').ok).toBe(false);
  });

  it('verify fails on signature with wrong byte length', () => {
    const token = signScope(base, 'test-secret');
    const [payload] = token.split('.');
    // Sub a known-shorter valid base64url signature
    const result = verifyScope(`${payload}.AAAA`, 'test-secret');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('signature');
  });

  it('verify fails on undecodable payload after passing signature length check', () => {
    // Sign valid bytes, then swap the payload portion for a string that the
    // HMAC can match shape-wise but JSON.parse will reject. Easiest way: forge
    // a new token where payload is non-JSON but signed correctly.
    const garbage = Buffer.from('not-json-at-all').toString('base64url');
    // Manually compute the HMAC over the garbage payload using same secret.
    const { createHmac } = require('node:crypto');
    const sig = createHmac('sha256', 'test-secret').update(garbage).digest('base64url');
    const result = verifyScope(`${garbage}.${sig}`, 'test-secret');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('malformed payload');
  });

  it('narrowScope reduces maxCostUsd', () => {
    const fresh: ExecutionScope = { ...base, expiresAt: Date.now() + 60_000 };
    const narrow = narrowScope(fresh, { maxCostUsd: 0.005 });
    expect(narrow.maxCostUsd).toBe(0.005);
    expect(narrow.maxLatencyMs).toBe(fresh.maxLatencyMs);
  });

  it('narrowScope cannot expand maxCostUsd beyond parent', () => {
    const narrow = narrowScope(base, { maxCostUsd: 999 });
    expect(narrow.maxCostUsd).toBe(base.maxCostUsd);
  });

  it('narrowScope cannot expand maxLatencyMs beyond parent', () => {
    const narrow = narrowScope(base, { maxLatencyMs: 999_999 });
    expect(narrow.maxLatencyMs).toBe(base.maxLatencyMs);
  });

  it('narrowScope cannot expand ttlMs beyond parent', () => {
    const narrow = narrowScope(base, { ttlMs: 999_999_999 });
    expect(narrow.ttlMs).toBeLessThanOrEqual(base.ttlMs);
  });

  it('narrowScope expiresAt cannot exceed parent expiresAt (attenuation)', async () => {
    // Parent half-spent: created notionally 50s ago with 60s ttl.
    const now = Date.now();
    const halfSpent: ExecutionScope = {
      ...base,
      ttlMs: 60_000,
      expiresAt: now + 10_000, // 10s left
    };
    // Child requests parent's full ttlMs (60s) — must NOT outlive parent.
    const narrow = narrowScope(halfSpent, { ttlMs: 60_000 });
    expect(narrow.expiresAt).toBeLessThanOrEqual(halfSpent.expiresAt);
    expect(narrow.ttlMs).toBeLessThanOrEqual(halfSpent.expiresAt - now + 5); // small slack
  });

  it('narrowScope with no overrides still respects parent expiresAt', () => {
    const halfSpent: ExecutionScope = {
      ...base,
      ttlMs: 60_000,
      expiresAt: Date.now() + 5_000,
    };
    const narrow = narrowScope(halfSpent, {});
    expect(narrow.expiresAt).toBeLessThanOrEqual(halfSpent.expiresAt);
  });

  it('narrowScope can only remove modes, never add', () => {
    const limited: ExecutionScope = { ...base, allowedModes: ['fast'] };
    const narrow = narrowScope(limited, {
      allowedModes: ['fast', 'verified', 'consensus'],
    });
    expect(narrow.allowedModes).toEqual(['fast']);
  });

  it('narrowScope filters out unknown modes', () => {
    const narrow = narrowScope(base, {
      allowedModes: ['fast', 'turbo' as never],
    });
    expect(narrow.allowedModes).toEqual(['fast']);
  });
});
