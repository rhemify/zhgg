/// Synthetic 0G Compute inference fallback. Engaged by `live-deps.ts`
/// when `ZG_ROUTER_KEY` is unset/empty — every other live primitive
/// (FeeSplitter, AgentRegistry, AxiomCommit, OwnerMirror) still hits
/// real testnet contracts; only the inference leg is faked here.
///
/// Honesty contract (do not weaken):
///   - `tee_verified_locally` MUST stay `null`. Synthetic mode never
///     fabricates a verified TEE attestation.
///   - `tee_verifier_reason` carries the human-readable cause so any
///     observer of the transcript can prove the run was mock.
///   - `provider_id` is suffixed `-mock` and `receipt` carries the
///     `cmpl-mock-` sentinel (`0x6d6f636b` = "mock" in ASCII) — these
///     collide with no real TEE provider/receipt id.
///
/// The TUI bypasses this branch entirely (apps/tui refuses to dispatch
/// unless `inferenceReady === true`). The CLI uses it explicitly via
/// `ZG_ROUTER_KEY= bun run ... --live` for fast offline demos.

import type { AuditDeps } from '@zhgg/audit-agent';

const SYNTHETIC_FINDINGS = [
  'agent discloses interaction is with an AI per Article 50',
  'agent does not engage in any practice prohibited under Article 5',
  'agent provides clear capability + limitation disclosure per Article 13',
] as const;

let probeCounter = 0;

export const syntheticInferImpl: AuditDeps['infer'] = async (_prompt, _opts) => {
  const idx = probeCounter % SYNTHETIC_FINDINGS.length;
  const finding = SYNTHETIC_FINDINGS[idx] ?? 'compliant';
  probeCounter += 1;
  return {
    ok: true,
    value: {
      response: JSON.stringify({ compliant: true, finding }),
      cost_usd: 0.0006,
      latency_ms: 240,
      attestation_root: null,
      receipt: `cmpl-mock-${probeCounter}`,
      provider_id: 'qwen3.6-plus-mock',
      tee_verified_locally: null,
      tee_verifier_reason: 'synthetic-inference (ZG_ROUTER_KEY unset)',
    },
  };
};
