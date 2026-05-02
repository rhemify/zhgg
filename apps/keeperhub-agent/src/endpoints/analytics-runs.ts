/// `GET /api/analytics/runs?status=…&range=…` — newest-first execution
/// feed.
///
/// KH returns either an array directly or `{ runs: [...] }` depending on
/// rollout. We accept both — defensive parsing rather than assuming one
/// shape, and surface anything else as `malformed_response`.

import type { KHClient } from '../client.js';
import type { KHResult } from '../index.js';
import type { KHAnalyticsRun } from '../types.js';

export type RunStatusFilter = 'success' | 'error' | 'pending';
export type RunRangeFilter = '1h' | '24h' | '7d';

export interface RunsArgs {
  status?: RunStatusFilter;
  range?: RunRangeFilter;
}

export async function getAnalyticsRuns(
  client: KHClient,
  args: RunsArgs = {},
): Promise<KHResult<KHAnalyticsRun[]>> {
  const res = await client.get<unknown>('/api/analytics/runs', {
    status: args.status,
    range: args.range,
  });
  if (!res.ok) return res;
  const parsed = res.value;

  let raw: unknown[];
  if (Array.isArray(parsed)) {
    raw = parsed;
  } else if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { runs?: unknown }).runs)) {
    raw = (parsed as { runs: unknown[] }).runs;
  } else {
    return {
      ok: false,
      error: {
        kind: 'malformed_response',
        reason: `expected array or {runs:[]}, got ${typeof parsed}: ${JSON.stringify(parsed).slice(0, 240)}`,
      },
    };
  }

  const runs: KHAnalyticsRun[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.executionId !== 'string') continue;
    runs.push({
      ...r,
      executionId: r.executionId,
      workflowId: typeof r.workflowId === 'string' ? r.workflowId : undefined,
      workflowName: typeof r.workflowName === 'string' ? r.workflowName : undefined,
      status: typeof r.status === 'string' ? r.status : 'unknown',
      startedAt: typeof r.startedAt === 'string' ? r.startedAt : undefined,
      completedAt: typeof r.completedAt === 'string' ? r.completedAt : undefined,
      spendWei: typeof r.spendWei === 'string' ? r.spendWei : undefined,
    });
  }
  return { ok: true, value: runs };
}
