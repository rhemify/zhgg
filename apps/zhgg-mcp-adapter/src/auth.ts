/// Bearer-token gate for KeeperHub-callable endpoints.
///
/// Hard rules:
///   - The token NEVER appears in any error message, log line, or
///     thrown payload. Every failure surfaces as a flat `unauthorized`
///     reason with NO echo of the supplied bearer.
///   - Comparison is constant-time-ish via a fixed-length scan. Slice Z
///     is not defending against side-channels (the threat model is KH
///     workflow auth, not a remote timing attacker), but since the cost
///     is one tiny helper, do it right.
///   - When `expected` is empty/undefined the check ALWAYS rejects —
///     `index.ts` refuses to start the server in that case, but defense
///     in depth means we don't accept an empty bearer either.

export interface AuthOk {
  ok: true;
}

export interface AuthErr {
  ok: false;
  status: 401;
  reason: 'missing_authorization' | 'malformed_authorization' | 'invalid_token';
}

export type AuthResult = AuthOk | AuthErr;

export function checkBearer(
  headerValue: string | null | undefined,
  expected: string | undefined,
): AuthResult {
  if (!expected || expected.length === 0) {
    return { ok: false, status: 401, reason: 'invalid_token' };
  }
  if (!headerValue) {
    return { ok: false, status: 401, reason: 'missing_authorization' };
  }
  const m = /^Bearer\s+(.+)$/.exec(headerValue.trim());
  if (!m || !m[1]) {
    return { ok: false, status: 401, reason: 'malformed_authorization' };
  }
  if (!constantTimeEquals(m[1], expected)) {
    return { ok: false, status: 401, reason: 'invalid_token' };
  }
  return { ok: true };
}

/// Length-aware constant-time string compare. Returns false immediately
/// on length mismatch (length itself isn't a secret), then walks the full
/// byte range XORing into an accumulator so the timing is independent of
/// where the first differing byte lives.
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) {
    acc |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return acc === 0;
}
