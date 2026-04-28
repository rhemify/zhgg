import type { InferenceIntent } from './intent.js';
import type { ExecutionScope } from './scope.js';

export type PolicyViolation =
  | { rule: 'spend_cap'; reason: string }
  | { rule: 'latency_cap'; reason: string }
  | { rule: 'mode_allowed'; reason: string }
  | { rule: 'not_expired'; reason: string };

export type PolicyResult =
  | { allowed: true }
  | { allowed: false; violations: PolicyViolation[] };

export function checkSpendCap(
  intent: InferenceIntent,
  scope: ExecutionScope,
): PolicyViolation | null {
  if (intent.max_cost_usd > scope.maxCostUsd) {
    return {
      rule: 'spend_cap',
      reason: `requested ${intent.max_cost_usd} exceeds scope cap ${scope.maxCostUsd}`,
    };
  }
  return null;
}

export function checkLatencyCap(
  intent: InferenceIntent,
  scope: ExecutionScope,
): PolicyViolation | null {
  if (intent.max_latency_ms > scope.maxLatencyMs) {
    return {
      rule: 'latency_cap',
      reason: `requested ${intent.max_latency_ms} exceeds scope cap ${scope.maxLatencyMs}`,
    };
  }
  return null;
}

export function checkModeAllowed(
  intent: InferenceIntent,
  scope: ExecutionScope,
): PolicyViolation | null {
  if (!scope.allowedModes.includes(intent.mode)) {
    return {
      rule: 'mode_allowed',
      reason: `mode '${intent.mode}' not in allowed modes [${scope.allowedModes.join(', ')}]`,
    };
  }
  return null;
}

export function checkNotExpired(
  scope: ExecutionScope,
  now: number,
): PolicyViolation | null {
  if (now >= scope.expiresAt) {
    return {
      rule: 'not_expired',
      reason: `scope expired at ${new Date(scope.expiresAt).toISOString()}; now is ${new Date(now).toISOString()}`,
    };
  }
  return null;
}

export function evaluate(
  intent: InferenceIntent,
  scope: ExecutionScope,
  now?: number,
): PolicyResult {
  const t = now ?? Date.now();
  const violations: PolicyViolation[] = [];

  const spend = checkSpendCap(intent, scope);
  if (spend) violations.push(spend);

  const latency = checkLatencyCap(intent, scope);
  if (latency) violations.push(latency);

  const mode = checkModeAllowed(intent, scope);
  if (mode) violations.push(mode);

  const expired = checkNotExpired(scope, t);
  if (expired) violations.push(expired);

  if (violations.length === 0) return { allowed: true };
  return { allowed: false, violations };
}
