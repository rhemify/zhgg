import { createHmac, timingSafeEqual } from 'node:crypto';
import { MODES, type Mode } from './intent.js';
import type { Result } from './result.js';

export interface ExecutionScope {
  allowedModes: Mode[];
  maxCostUsd: number;
  maxLatencyMs: number;
  ttlMs: number;
  expiresAt: number;
}

interface CreateScopeInput {
  allowedModes: Mode[];
  maxCostUsd: number;
  maxLatencyMs: number;
  ttlMs: number;
}

export function createScope(input: CreateScopeInput): ExecutionScope {
  return { ...input, expiresAt: Date.now() + input.ttlMs };
}

export function signScope(scope: ExecutionScope, secret: string): string {
  const payload = Buffer.from(JSON.stringify(scope)).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyScope(token: string, secret: string): Result<ExecutionScope> {
  const dot = token.lastIndexOf('.');
  if (dot === -1 || dot === 0 || dot === token.length - 1) {
    return { ok: false, error: 'malformed token' };
  }

  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig, 'base64url');
  const expectedBuf = Buffer.from(expected, 'base64url');

  // Length precheck is required (timingSafeEqual throws on length mismatch).
  // Leak surface is fixed-shape ("wrong length"), not secret-dependent.
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return { ok: false, error: 'invalid signature' };
  }

  let scope: ExecutionScope;
  try {
    scope = JSON.parse(Buffer.from(payload, 'base64url').toString()) as ExecutionScope;
  } catch {
    return { ok: false, error: 'malformed payload' };
  }

  if (Date.now() >= scope.expiresAt) {
    return { ok: false, error: 'token expired' };
  }

  return { ok: true, value: scope };
}

const VALID_MODES = new Set<string>(MODES);

export function narrowScope(
  parent: ExecutionScope,
  overrides: Partial<Omit<ExecutionScope, 'expiresAt'>>,
): ExecutionScope {
  const narrowedModes = overrides.allowedModes
    ? overrides.allowedModes.filter(
        (m) => parent.allowedModes.includes(m) && VALID_MODES.has(m),
      )
    : parent.allowedModes;

  const requestedTtl =
    overrides.ttlMs !== undefined ? Math.min(overrides.ttlMs, parent.ttlMs) : parent.ttlMs;

  // Attenuation: child expiresAt cannot outlive parent. If parent is half-spent,
  // child gets at most the remaining lifetime, never a fresh window.
  const candidateExpiresAt = Date.now() + requestedTtl;
  const expiresAt = Math.min(candidateExpiresAt, parent.expiresAt);
  const ttlMs = Math.max(0, expiresAt - Date.now());

  return {
    allowedModes: narrowedModes,
    maxCostUsd: Math.min(overrides.maxCostUsd ?? parent.maxCostUsd, parent.maxCostUsd),
    maxLatencyMs: Math.min(overrides.maxLatencyMs ?? parent.maxLatencyMs, parent.maxLatencyMs),
    ttlMs,
    expiresAt,
  };
}
