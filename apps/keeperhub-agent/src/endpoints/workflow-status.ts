/// `GET /api/workflows/executions/{executionId}/status` — full run state.
///
/// Returns a `KHWorkflowExecution` with optional `steps[]`. We coerce
/// loose shapes defensively: `steps` is normalised to an array (or
/// undefined when absent), and the workflow-level `status` is required —
/// missing it means the server returned something we can't map. Server
/// drift surfaces as `malformed_response`.

import type { KHClient } from '../client.js';
import type { KHResult } from '../index.js';
import type { KHWorkflowExecution, KHWorkflowStep, KHWorkflowStatus } from '../types.js';

const VALID_STATUSES: ReadonlySet<KHWorkflowStatus> = new Set<KHWorkflowStatus>([
  'pending',
  'running',
  'success',
  'error',
  'cancelled',
]);

export async function getWorkflowStatus(
  client: KHClient,
  executionId: string,
): Promise<KHResult<KHWorkflowExecution>> {
  if (typeof executionId !== 'string' || executionId.length === 0) {
    return { ok: false, error: { kind: 'bad_request', reason: 'executionId required' } };
  }
  const path = `/api/workflows/executions/${encodeURIComponent(executionId)}/status`;
  const res = await client.get<unknown>(path);
  if (!res.ok) return res;
  const parsed = res.value;
  if (typeof parsed !== 'object' || parsed === null) {
    return {
      ok: false,
      error: { kind: 'malformed_response', reason: `expected object, got ${typeof parsed}` },
    };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.executionId !== 'string') {
    return {
      ok: false,
      error: {
        kind: 'malformed_response',
        reason: `missing executionId in status response: ${JSON.stringify(parsed).slice(0, 240)}`,
      },
    };
  }
  if (typeof obj.status !== 'string' || !VALID_STATUSES.has(obj.status as KHWorkflowStatus)) {
    return {
      ok: false,
      error: {
        kind: 'malformed_response',
        reason: `unknown status "${String(obj.status)}" — expected one of ${[...VALID_STATUSES].join('|')}`,
      },
    };
  }
  let steps: KHWorkflowStep[] | undefined;
  if (Array.isArray(obj.steps)) {
    steps = obj.steps
      .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
      .map((s) => {
        const nodeId = typeof s.nodeId === 'string'
          ? s.nodeId
          : typeof s.id === 'string' ? s.id : '?';
        return {
          ...s,
          nodeId,
          label: typeof s.label === 'string' ? s.label : undefined,
          status: typeof s.status === 'string' ? s.status : undefined,
          txHash: typeof s.txHash === 'string' ? s.txHash : undefined,
          error: typeof s.error === 'string' ? s.error : undefined,
        } as KHWorkflowStep;
      });
  }
  return {
    ok: true,
    value: {
      ...obj,
      executionId: obj.executionId,
      status: obj.status as KHWorkflowStatus,
      workflowId: typeof obj.workflowId === 'string' ? obj.workflowId : undefined,
      startedAt: typeof obj.startedAt === 'string' ? obj.startedAt : undefined,
      completedAt: typeof obj.completedAt === 'string' ? obj.completedAt : undefined,
      error: typeof obj.error === 'string' ? obj.error : undefined,
      steps,
    },
  };
}
