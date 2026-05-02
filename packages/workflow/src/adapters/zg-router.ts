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
  attestation_root: string | null;
  receipt: string;
  provider_id: string;
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
  const attestation_root = traceVerified
    ? `tee_verified:${typeof body.trace?.provider === 'string' ? body.trace.provider : 'unknown'}`
    : headerAttest;
  const receipt = typeof body.id === 'string' ? body.id : '';
  const provider_id = typeof body.model === 'string' ? body.model : model;

  return {
    ok: true,
    value: { response: content, cost_usd, latency_ms, attestation_root, receipt, provider_id },
  };
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
