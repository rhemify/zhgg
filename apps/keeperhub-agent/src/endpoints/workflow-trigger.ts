/// `POST /api/workflow/{workflowId}/execute` — fire a saved workflow.
///
/// Returns `{ executionId, status: "pending" }` per the KH docs (the
/// run is async; status reads come from `workflow-status.ts`). We
/// validate that `executionId` is a non-empty string before returning
/// success — anything else surfaces as `malformed_response` with the
/// raw payload so operators can inspect the drift.

import type { KHClient } from '../client.js';
import type { KHResult } from '../index.js';
import type { KHWorkflowExecution } from '../types.js';

export interface TriggerArgs {
  workflowId: string;
  /// Free-form input map passed to the workflow's first node. KH docs
  /// don't constrain this — pass through whatever the user provided.
  inputs?: Record<string, unknown>;
}

export async function triggerWorkflow(
  client: KHClient,
  args: TriggerArgs,
): Promise<KHResult<KHWorkflowExecution>> {
  if (typeof args.workflowId !== 'string' || args.workflowId.length === 0) {
    return { ok: false, error: { kind: 'bad_request', reason: 'workflowId required' } };
  }
  const path = `/api/workflow/${encodeURIComponent(args.workflowId)}/execute`;
  const body = { inputs: args.inputs ?? {} };
  const res = await client.post<unknown>(path, body);
  if (!res.ok) return res;
  const parsed = res.value;
  if (typeof parsed !== 'object' || parsed === null) {
    return {
      ok: false,
      error: {
        kind: 'malformed_response',
        reason: `expected object, got ${typeof parsed}`,
      },
    };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.executionId !== 'string' || obj.executionId.length === 0) {
    return {
      ok: false,
      error: {
        kind: 'malformed_response',
        reason: `missing executionId in trigger response: ${JSON.stringify(parsed).slice(0, 240)}`,
      },
    };
  }
  return {
    ok: true,
    value: {
      executionId: obj.executionId,
      status: (typeof obj.status === 'string' ? obj.status : 'pending') as KHWorkflowExecution['status'],
      workflowId: typeof obj.workflowId === 'string' ? obj.workflowId : args.workflowId,
      ...obj,
    },
  };
}
