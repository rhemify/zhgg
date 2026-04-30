/// 0G Compute Router adapter — OpenAI-compatible HTTP client.
///
/// Talks to 0G's router-api at https://router-api.0g.ai/v1, which proxies
/// to a TEE-backed provider mesh. Authentication is a `sk-` key minted at
/// pc.0g.ai. Preferred over the direct broker SDK for hackathon timelines
/// because it avoids ethers v5 setup and per-provider ledger funding.
///
/// Returns a Result envelope so callers never see thrown exceptions in the
/// business path; transport, config and malformed-response failures are
/// modeled as discriminated error variants.

const DEFAULT_BASE_URL = 'https://router-api.0g.ai/v1';
const DEFAULT_MODEL = 'qwen3.6-plus';
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
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: FetchLike;
}

interface OpenAIChoice {
  message?: { role?: string; content?: unknown };
}

interface OpenAIResponse {
  id?: unknown;
  model?: unknown;
  choices?: OpenAIChoice[];
  usage?: { total_tokens?: unknown };
}

export async function inferZG(
  prompt: string,
  opts: ZGRouterOptions = {}
): Promise<Result<ZGInferenceResult, ZGRouterError>> {
  const apiKey = opts.apiKey ?? process.env.ZG_ROUTER_KEY;
  const baseUrl = opts.baseUrl ?? process.env.ZG_ROUTER_BASE_URL ?? DEFAULT_BASE_URL;
  const model = opts.model ?? DEFAULT_MODEL;
  const fetchImpl = opts.fetchImpl ?? fetch;

  if (!apiKey) {
    return { ok: false, error: { kind: 'config', reason: 'ZG_ROUTER_KEY not set' } };
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
  const attestation_root = res.headers.get(TEE_ATTESTATION_HEADER);
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
