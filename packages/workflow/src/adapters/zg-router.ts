/// 0G Compute Router adapter — OpenAI-compatible HTTP client.
///
/// Talks to 0G's router-api (testnet endpoint per pc.0g.ai docs) which
/// proxies to a TEE-backed provider mesh. Authentication is a `sk-` key
/// minted at pc.0g.ai. Preferred over the direct broker SDK for
/// hackathon timelines because it avoids ethers v5 setup and per-provider
/// ledger funding.
///
/// `verify_tee: true` in the request body asks the router to perform
/// on-chain signature verification of the provider's TEE attestation;
/// the response includes a `tee_verified` field in its `trace` block.
/// We forward this flag when `opts.verifyTee` is set.
///
/// `teeVerifierUrl` (optional) pipes the returned attestation envelope
/// through a local `tee-verifier` sidecar (apps/tee-verifier) so we
/// re-verify the structural binding ourselves instead of trusting the
/// router's `tee_verified` boolean blindly. When set, the result carries
/// `tee_verified_locally: boolean | null` plus an honest reason string.
/// When unset, behavior is unchanged (legacy path) and the field is null.
///
/// Returns a Result envelope so callers never see thrown exceptions in the
/// business path; transport, config and malformed-response failures are
/// modeled as discriminated error variants.

const DEFAULT_BASE_URL = 'https://router-api-testnet.integratenetwork.work/v1';
const DEFAULT_MODEL = 'qwen/qwen-2.5-7b-instruct';
const ZG_USD_PER_1K_TOKENS = 0.003; // ~10x cheaper than GPT-4 per /docs/0g.md
const TEE_ATTESTATION_HEADER = 'x-tee-attestation';

export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export interface ZGInferenceResult {
  response: string;
  cost_usd: number;
  latency_ms: number;
  /// Legacy attestation slot. Carries either the raw header value or the
  /// `tee_verified:<provider>` sentinel string. Kept so existing receipts
  /// (and the on-chain `attestationRoot` field) don't break — but new
  /// canonical-report consumers should prefer the structured fields below.
  attestation_root: string | null;
  /// Structured router-trace verdict: did the router itself confirm the
  /// provider's TEE attestation? `true` only when `body.trace.tee_verified
  /// === true`. `null` when no trace block (e.g. verify_tee not requested)
  /// or the field was missing. Never silently `false` for a missing trace —
  /// honest "unknown" beats a confident-looking lie in regulator-readable
  /// receipts.
  tee_verified: boolean | null;
  /// Provider name from `body.trace.provider` (e.g. `'qwen-tee-1'`). Null
  /// when no trace or provider absent. Stored alongside `tee_verified` so a
  /// regulator can identify *which* TEE provider attested the inference.
  tee_provider: string | null;
  receipt: string;
  provider_id: string;
  /// Result of re-verifying the TEE attestation locally against the
  /// `tee-verifier` sidecar. `true` = verifier returned `valid:true`;
  /// `false` = verifier returned `valid:false` (binding mismatch, bad
  /// quote, etc); `null` = local verify was not requested OR the verifier
  /// was unreachable / no attestation envelope was available. When `null`,
  /// `tee_verifier_reason` carries the honest cause. Never faked.
  tee_verified_locally: boolean | null;
  /// Human-readable reason accompanying `tee_verified_locally`. Always
  /// `null` when local verify was not requested. Otherwise a short string
  /// like `'verifier_unreachable: ECONNREFUSED'` or `'no_attestation_envelope'`.
  tee_verifier_reason: string | null;
}

export type ZGRouterError =
  | { kind: 'config'; reason: string }
  | { kind: 'transport'; reason: string; status?: number }
  | { kind: 'malformed_response'; reason: string };

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ZGRouterOptions {
  /// REQUIRED. The 0G Compute Router `sk-` API key. Must come from the
  /// caller's credential store (e.g. KeeperHub credentials), NEVER from
  /// `process.env` inside the library — silent env fallback in a
  /// multi-tenant host bleeds the host's key into a tenant whose
  /// credentials weren't loaded. Standalone runners read env explicitly
  /// at the entrypoint and pass the value in.
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: FetchLike;
  /// When true, ask the router to perform on-chain signature verification
  /// of the provider's TEE attestation. Adds a `verify_tee: true` flag in
  /// the request body; the router's response then includes a
  /// `trace.tee_verified` boolean we surface in `attestation_root`. Costs
  /// a tiny bit of extra latency (~100-300ms typical).
  verifyTee?: boolean;
  /// Optional URL of the local `tee-verifier` HTTP sidecar (e.g.
  /// `http://localhost:8787/verify`). When set, after a successful
  /// inference we POST the returned attestation envelope to the verifier
  /// and surface its verdict in `tee_verified_locally`. Unreachable /
  /// missing-envelope cases set the field to `null` with an honest
  /// `tee_verifier_reason` — never throws, never fakes a verified result.
  teeVerifierUrl?: string;
}

interface OpenAIChoice {
  message?: { role?: string; content?: unknown };
}

interface OpenAIResponse {
  id?: unknown;
  model?: unknown;
  choices?: OpenAIChoice[];
  usage?: { total_tokens?: unknown };
  /// 0G router-only — present when `verify_tee: true` was sent.
  trace?: {
    tee_verified?: unknown;
    provider?: unknown;
    [k: string]: unknown;
  };
}

export async function inferZG(
  prompt: string,
  opts: ZGRouterOptions
): Promise<Result<ZGInferenceResult, ZGRouterError>> {
  const apiKey = opts.apiKey;
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const model = opts.model ?? DEFAULT_MODEL;
  const fetchImpl = opts.fetchImpl ?? fetch;

  if (!apiKey) {
    return { ok: false, error: { kind: 'config', reason: 'apiKey is empty' } };
  }

  const start = Date.now();
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        ...(opts.verifyTee ? { verify_tee: true } : {}),
      }),
    });
  } catch (e) {
    return { ok: false, error: { kind: 'transport', reason: errorMessage(e) } };
  }

  if (!res.ok) {
    return {
      ok: false,
      error: { kind: 'transport', reason: `HTTP ${res.status}`, status: res.status },
    };
  }

  let body: OpenAIResponse;
  try {
    body = (await res.json()) as OpenAIResponse;
  } catch (e) {
    return { ok: false, error: { kind: 'malformed_response', reason: errorMessage(e) } };
  }

  const choice = body.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string') {
    return {
      ok: false,
      error: { kind: 'malformed_response', reason: 'missing choices[0].message.content' },
    };
  }

  const totalTokens = typeof body.usage?.total_tokens === 'number' ? body.usage.total_tokens : 0;
  const cost_usd = (totalTokens / 1000) * ZG_USD_PER_1K_TOKENS;
  const latency_ms = Date.now() - start;
  // Two attestation sources:
  //   - x-tee-attestation header (legacy / direct broker SDK path)
  //   - body.trace.tee_verified (router's verify_tee flag — Phase 23)
  // We prefer the trace boolean when present and fall back to the
  // header otherwise. Encode "verified" as a non-null sentinel so
  // downstream consumers can tell verified from unverified.
  const headerAttest = res.headers.get(TEE_ATTESTATION_HEADER);
  const traceVerified = body.trace?.tee_verified === true;
  const traceProvider =
    typeof body.trace?.provider === 'string' ? body.trace.provider : null;
  const attestation_root = traceVerified
    ? `tee_verified:${traceProvider ?? 'unknown'}`
    : headerAttest;
  // Structured fields: only populated when the router actually returned a
  // trace block. `null` rather than `false` for missing trace so a
  // regulator-side parser can distinguish "router said no" from "we never
  // asked / the router didn't tell us." Same rule as `attestation_root`:
  // honest unknown beats a fabricated negative.
  const tee_verified: boolean | null =
    body.trace === undefined || body.trace?.tee_verified === undefined
      ? null
      : traceVerified;
  const tee_provider: string | null = traceProvider;
  const receipt = typeof body.id === 'string' ? body.id : '';
  const provider_id = typeof body.model === 'string' ? body.model : model;

  // Optional: re-verify the attestation envelope ourselves through the
  // local tee-verifier sidecar. We never throw and never fake a verdict —
  // honest fallback is `null` + reason. Caller opts in by setting
  // `teeVerifierUrl`; otherwise both fields stay null.
  let tee_verified_locally: boolean | null = null;
  let tee_verifier_reason: string | null = null;
  if (opts.teeVerifierUrl) {
    const verdict = await reverifyAttestationLocally({
      verifierUrl: opts.teeVerifierUrl,
      headerAttest,
      fetchImpl,
    });
    tee_verified_locally = verdict.verified;
    tee_verifier_reason = verdict.reason;
  }

  return {
    ok: true,
    value: {
      response: content,
      cost_usd,
      latency_ms,
      attestation_root,
      tee_verified,
      tee_provider,
      receipt,
      provider_id,
      tee_verified_locally,
      tee_verifier_reason,
    },
  };
}

/// Posts the (best available) attestation envelope to the local verifier
/// and returns a normalized verdict. Never throws. The verifier expects
/// `{ intel_quote, signing_address, signing_algo?, request_nonce? }`; we
/// extract these from the `x-tee-attestation` envelope when present.
async function reverifyAttestationLocally(args: {
  verifierUrl: string;
  headerAttest: string | null;
  fetchImpl: FetchLike;
}): Promise<{ verified: boolean | null; reason: string | null }> {
  if (!args.headerAttest || args.headerAttest.trim() === '') {
    return { verified: null, reason: 'no_attestation_envelope' };
  }
  let envelope: { intel_quote?: unknown; signing_address?: unknown; signing_algo?: unknown; request_nonce?: unknown };
  try {
    const trimmed = args.headerAttest.trim();
    const raw = trimmed.startsWith('{') ? trimmed : safeBase64Decode(trimmed);
    envelope = JSON.parse(raw) as typeof envelope;
  } catch (e) {
    return { verified: null, reason: `envelope_parse_error: ${errorMessage(e)}` };
  }
  if (typeof envelope.intel_quote !== 'string' || typeof envelope.signing_address !== 'string') {
    return { verified: null, reason: 'envelope_missing_required_fields' };
  }
  let res: Response;
  try {
    res = await args.fetchImpl(args.verifierUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intel_quote: envelope.intel_quote,
        signing_address: envelope.signing_address,
        signing_algo: typeof envelope.signing_algo === 'string' ? envelope.signing_algo : undefined,
        request_nonce: typeof envelope.request_nonce === 'string' ? envelope.request_nonce : undefined,
      }),
    });
  } catch (e) {
    return { verified: null, reason: `verifier_unreachable: ${errorMessage(e)}` };
  }
  if (!res.ok) {
    return { verified: null, reason: `verifier_http_${res.status}` };
  }
  let body: { valid?: unknown; reason?: unknown; verdict?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch (e) {
    return { verified: null, reason: `verifier_bad_json: ${errorMessage(e)}` };
  }
  if (body.valid === true) {
    const verdict = typeof body.verdict === 'string' ? body.verdict : 'structural';
    return { verified: true, reason: `verifier_ok:${verdict}` };
  }
  const why = typeof body.reason === 'string' ? body.reason : 'valid_not_true';
  return { verified: false, reason: `verifier_rejected: ${why}` };
}

function safeBase64Decode(s: string): string {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  if (typeof Buffer !== 'undefined') return Buffer.from(norm, 'base64').toString('utf8');
  return atob(norm);
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
