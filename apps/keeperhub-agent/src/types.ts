/// KeeperHub direct-API response shapes.
///
/// We deliberately keep these LOOSE (mostly `unknown` / optional) — the
/// docs in `docs/keeperhub-research/kh-api.md` are explicit that several
/// fields drift across endpoints (status enum drift, JSON-encoded
/// strings, etc.). Parse defensively at call sites; the executor returns
/// `malformed_response` when a required scalar is missing or the wrong
/// shape, surfacing whatever the server actually sent.

/// Status reported on a saved-workflow execution. The KH docs note that
/// workflow runs use the `pending|running|success|error|cancelled`
/// alphabet (NOT the direct-execution `completed|failed` set). We don't
/// alias them — the union below is exactly what the workflows endpoint
/// returns.
export type KHWorkflowStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'error'
  | 'cancelled';

/// Per-node step inside a workflow execution. Field set varies by node
/// type (transfer / contract-call / branch / …) — we keep everything
/// optional except the node identifier the caller needs to render a row.
export interface KHWorkflowStep {
  /// Stable per-node ID (e.g. "step-1" / "transfer-usdc"). Required.
  nodeId: string;
  /// Human-readable node label, when present.
  label?: string;
  /// Per-node status. May not match the workflow-level status alphabet.
  status?: string;
  /// On-chain hash for nodes that submitted a tx. NEVER fabricated —
  /// when KH returns nothing we leave it undefined.
  txHash?: string;
  /// Free-form error text from the server. Surfaced verbatim.
  error?: string;
  /// Anything else the server returned. Renderers can spread this for
  /// debug panels.
  [extra: string]: unknown;
}

/// Saved-workflow execution record. Returned by:
///   - `POST /api/workflow/{id}/execute` (only `executionId` + `status`)
///   - `GET  /api/workflows/executions/{id}/status` (full state)
export interface KHWorkflowExecution {
  executionId: string;
  status: KHWorkflowStatus;
  /// Workflow ID this execution belongs to. Optional on the trigger
  /// response (KH echoes the URL param), required on the status read.
  workflowId?: string;
  startedAt?: string;
  completedAt?: string;
  steps?: KHWorkflowStep[];
  /// Surfaced verbatim when the run errored.
  error?: string;
  /// Anything else.
  [extra: string]: unknown;
}

// NOTE: KHAnalyticsRun + KHSpendCap removed 2026-05-02 after live probe
// confirmed `/api/analytics/runs` and `/api/analytics/spend-cap` are
// NOT deployed for kh_ bearer auth on app.keeperhub.com (404 / 401).
// Re-add when KH ships them; until then, list_workflows + list_integrations
// are the only read surfaces that work.
