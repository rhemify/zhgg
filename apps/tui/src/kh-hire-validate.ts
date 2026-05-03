/// Slice X — pure pre-flight validators for `kh hire`.
///
/// Extracted from `dispatchKHHireIntent` so the refusal paths are
/// unit-testable without spinning up the full TUI render loop. Each
/// helper takes the data the dispatcher already has in hand (the
/// inspected `KHPublicWorkflow`, the operator-supplied inputs) and
/// returns either `{ ok: true, ... }` or a typed refusal envelope
/// the dispatcher can drop straight into a `pushAudit` row.
///
/// The dispatcher itself remains responsible for the IMPURE legs:
///   - reading env (KH_API_KEY, KH_AUTHOR_*),
///   - actually calling `executeKHCall({kind:'inspect',...})`,
///   - the x402 round-trip via `payViaKeeperHubMarketplace`.
///
/// These two helpers cover the deterministic refusals — null slug and
/// missing required keys — which are exactly the assertions a test can
/// make without faking on-chain state.

import type { KHPublicWorkflow } from '@zhgg/keeperhub-agent';

/// Resolve `slugOrId` into a real, x402-callable slug. Returns:
///   - `{ ok: true, slug }`             — slug-callable, dispatcher proceeds
///   - `{ ok: false, kind: 'no-slug' }` — workflow exists but has
///                                        `listedSlug === null` (discoverable
///                                        but not yet slug-callable; the
///                                        author hasn't registered a public
///                                        slug on KH)
export type SlugResolution =
  | { ok: true; slug: string; workflow: KHPublicWorkflow }
  | { ok: false; kind: 'no-slug'; workflowId: string };

/// Given the operator's `<slugOrId>` input AND the matched
/// `KHPublicWorkflow` (resolved by the dispatcher via inspect or
/// discover-fallback), decide whether the workflow is x402-callable.
///
/// The "matched" lookup is the dispatcher's job — by the time we get
/// here we know the workflow exists in the public catalog. The only
/// remaining question is whether KH has assigned it a `listedSlug`.
export function resolveCallableSlug(workflow: KHPublicWorkflow): SlugResolution {
  if (workflow.listedSlug === null) {
    return { ok: false, kind: 'no-slug', workflowId: workflow.id };
  }
  return { ok: true, slug: workflow.listedSlug, workflow };
}

/// Validate the operator's `inputs` JSON object against the workflow's
/// `inputSchema.required[]` array. Returns the FIRST missing key by
/// name so the dispatcher's refusal row is deterministic + actionable.
///
/// We deliberately don't run a full JSON Schema validator here:
///   - KH's schemas are loose (`additionalProperties: true` on most
///     entries), so a schema-strict pass would over-refuse.
///   - The required[] check is the only HARD gate that maps 1:1 to a
///     workflow runtime error ("missing input X"). Type / shape
///     mismatches surface from the workflow itself on retry — and the
///     server's response bubbles into the audit trail verbatim.
export type InputValidation =
  | { ok: true }
  | { ok: false; missing: string; required: readonly string[] };

export function validateRequiredInputs(
  workflow: KHPublicWorkflow,
  inputs: Record<string, unknown> | undefined,
): InputValidation {
  const required = workflow.inputSchema?.required ?? [];
  const provided = inputs ?? {};
  for (const key of required) {
    if (!(key in provided)) {
      return { ok: false, missing: key, required };
    }
  }
  return { ok: true };
}
