/// `GET /api/analytics/spend-cap` — org-level daily limit + remaining.
///
/// Wire format from KH: `{ capWei, remainingWei, resetAt }` — both
/// scalars are decimal strings (treat as bigint at the call site).
/// Missing scalars surface as `malformed_response`; surplus fields
/// pass through via the spread so a future KH addition (e.g.
/// `softLimitWei`) doesn't require a code change here.

import type { KHClient } from '../client.js';
import type { KHResult } from '../index.js';
import type { KHSpendCap } from '../types.js';

export async function getSpendCap(client: KHClient): Promise<KHResult<KHSpendCap>> {
  const res = await client.get<unknown>('/api/analytics/spend-cap');
  if (!res.ok) return res;
  const parsed = res.value;
  if (typeof parsed !== 'object' || parsed === null) {
    return {
      ok: false,
      error: { kind: 'malformed_response', reason: `expected object, got ${typeof parsed}` },
    };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.capWei !== 'string' || typeof obj.remainingWei !== 'string') {
    return {
      ok: false,
      error: {
        kind: 'malformed_response',
        reason: `missing capWei or remainingWei: ${JSON.stringify(parsed).slice(0, 240)}`,
      },
    };
  }
  return {
    ok: true,
    value: {
      ...obj,
      capWei: obj.capWei,
      remainingWei: obj.remainingWei,
      resetAt: typeof obj.resetAt === 'string' ? obj.resetAt : undefined,
    },
  };
}
