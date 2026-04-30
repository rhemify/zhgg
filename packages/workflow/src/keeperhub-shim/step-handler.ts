/// Shim for `@/lib/workflow/executor/step-handler` from KeeperHub's monorepo.
///
/// When this plugin is dropped into `KeeperHub/keeperhub` via `cp -r`, the
/// `@/lib/...` import resolves to their real step-handler with logging,
/// retry tracking, and execution-context propagation. Standalone in this
/// repo, the shim provides a passthrough implementation so the same step
/// files run under bun without modification.
///
/// Source of truth: `KeeperHub/keeperhub/lib/workflow/executor/step-handler.ts`
/// (private). Surface inferred from `plugins/CLAUDE.md` example code.

export interface StepContext {
  executionId?: string;
  workflowId?: string;
  nodeId?: string;
  organizationId?: string;
}

export interface StepInput {
  _context?: StepContext;
}

/// In KeeperHub: wraps the step in a logging context with execution id,
/// node id, and structured input/output capture. Here: passthrough.
export async function withStepLogging<I extends StepInput, O>(
  _input: I,
  fn: () => O | Promise<O>
): Promise<O> {
  return await fn();
}
