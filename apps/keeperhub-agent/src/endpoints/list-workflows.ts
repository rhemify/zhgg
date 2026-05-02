/// `GET /api/workflows` — list all workflows visible to the org-key.
///
/// Empirically the only one of the documented analytics-style endpoints
/// that's actually deployed on `app.keeperhub.com` for `kh_` bearers
/// (the doc-set `/api/analytics/*` 401s or 404s on real probes). Returns
/// an array of workflow summaries — empty when the org has minted none.
///
/// Response shape per element is loose because KH's surface evolves; we
/// only assert the keys we render in the TUI and pass the rest through.

import type { KHClient } from '../client.js';
import type { KHResult } from '../index.js';

export interface KHWorkflowSummary {
  id: string;
  name?: string;
  /// Arbitrary tags KH attaches for marketplace search; absent on
  /// private workflows.
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  [extra: string]: unknown;
}

export async function listWorkflows(
  client: KHClient,
): Promise<KHResult<KHWorkflowSummary[]>> {
  const r = await client.get<unknown>('/api/workflows');
  if (!r.ok) return r;
  if (!Array.isArray(r.value)) {
    return {
      ok: false,
      error: {
        kind: 'malformed_response',
        reason: `expected array, got ${typeof r.value}`,
      },
    };
  }
  return { ok: true, value: r.value as KHWorkflowSummary[] };
}
