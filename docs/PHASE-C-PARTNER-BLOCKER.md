# Phase C — Partner-blocker: hosted 0G Compute Router missing provider URL + ZG-Res-Key header

> **Status**: deferred (zhgg cannot ship the missing piece without partner-side changes)
> **Audience**: 0G Compute team, KeeperHub team (KH/0G feedback bounty)
> **Date**: 2026-05-03
> **Related commits**: codex review Q5, Q10 (in plan file)

## TL;DR

zhgg's audit pipeline structurally verifies TEE attestation envelopes (parses TDX quotes, checks Intel QE vendor ID, binds `signing_address` to `report_data[0..20]`, binds `request_nonce` to `report_data[32..64]`, rejects non-`ecdsa` algos — see `apps/tee-verifier/src/verifier.ts:67-141`). What it **cannot** do today: actually receive a real per-response envelope from the hosted 0G Compute Router. Two pieces are missing on the Router side:

1. **Per-provider URL** — the Router does not expose which provider served the response, so we can't fetch the per-response attestation from `${providerBrokerURL}/v1/proxy/attestation/report?model=…`.
2. **`ZG-Res-Key` header** — the Router does not propagate the chatID needed to fetch the per-response signature from `${providerBrokerURL}/v1/proxy/signature/${chatID}?model=…`.

Without these, the verifier sidecar always returns `verified: null` with `reason: 'no_attestation_envelope'` (`packages/workflow/src/adapters/zg-router.ts:217`). The structural verification works on synthetic envelopes but never fires on real audits.

## Concrete asks (partner-side)

### 1. Surface provider URL in Router responses

Currently the Router response shape (per `packages/workflow/src/adapters/zg-router.ts:91-101`) carries only:

```ts
trace?: {
  tee_verified?: boolean;  // ← yes/no flag
  provider?: string;       // ← provider identifier (not URL)
  ...
};
```

**Ask**: extend with a `provider_url: string` field — the broker URL needed for `/v1/proxy/attestation/report?model=…` and `/v1/proxy/signature/${chatID}?model=…`. The SDK already gets this from on-chain service metadata via `listService()` → `service.url` (`/Users/aarontan/Developer/rhemify/0g-compute-ts-sdk/src.ts/sdk/inference/broker/request.ts:63-70`). The hosted Router has the same data — it just doesn't pass it through.

### 2. Propagate `ZG-Res-Key` response header

The SDK comment at `0g-compute-ts-sdk/src.ts/sdk/inference/broker/broker.ts:451-454` says:

> "The chat session ID returned by the provider in the `ZG-Res-Key` HTTP response header. Extract this header from the provider's response and pass it here for signature verification. For providers that don't include this header, fall back to using the completion ID."

The Router strips this header. Without it, `Verifier.fetchSignatureByChatID(svc.url, chatID, model)` (SDK `verifier.ts:855-862`) cannot be called.

**Ask**: when the Router proxies a chat-completions response, forward the upstream provider's `ZG-Res-Key` header to the caller verbatim.

## Why both are needed (the cryptographic gap)

The TEE attestation has two layers of trust:

1. **Quote** (TDX envelope) proves: "a TEE with this signer key is attested by Intel."
2. **Per-response signature** proves: "this specific completion was signed by that TEE's signer key."

Without the signature, an attacker who has obtained any valid TEE quote can replay it against responses they fabricated outside the enclave. The SDK does both checks in sequence (quote → signature → recover ECDSA signer → compare to TEE signer). zhgg's verifier already supports this two-step flow via `responseSignature` in `packages/workflow/src/tee-attestation.ts:67-70, :113-131` — the wrapper does ECDSA recovery locally — but `inferZG` cannot supply a signature because it can't fetch one from a URL it doesn't have.

Result: today's audit pipeline can prove "a valid TEE exists" but not "this audit response came from that TEE." Closing this requires both asks above OR pivoting zhgg to broker-direct (bypasses the Router entirely; documented in the plan as Phase C-A).

## Reference material

- `docs/keeperhub-research/kh-api.md` — adjacent partner-side API surface analysis
- `docs/keeperhub-research/kh-ops.md` — operational considerations
- `docs/keeperhub-research/kh-repos.md` — repo layout
- `docs/keeperhub-research/kh-workflows.md` — workflow shape
- `0g-compute-ts-sdk/src.ts/sdk/inference/broker/verifier.ts:805-861` — provider-direct attestation + signature endpoints
- `0g-compute-ts-sdk/src.ts/sdk/inference/broker/response.ts:25-106` — `processResponse` two-step verification
- `0g-compute-ts-sdk/llm_attestation_report.json` — LLM-format envelope shape (used to design the verifier's binding logic)

## What zhgg shipped now (despite the block)

The audit subsystem has been hardened so that *if* the partner ships the two changes above, zhgg's existing verifier path will exercise the new envelope correctly:

- `apps/tee-verifier/src/verifier.ts` — TDX quote parsing + structural binding (signing_address + request_nonce + signing_algo)
- `packages/workflow/src/adapters/zg-router.ts:182-260` — Router → sidecar wiring (already forwards header when present)
- `packages/workflow/src/tee-attestation.ts:155-200` — STRICT-mode wrapper now forwards all four envelope fields (`intel_quote`, `signing_address`, `signing_algo`, `request_nonce`) to the sidecar

Adding `provider_url` + `ZG-Res-Key` on the Router side flips zhgg from "structural verification on synthetic data" to "full cryptographic verification on every audit" with no client-side code changes beyond a single `fetchLLMAttestation` + `fetchResponseSignature` call after `inferZG`.
