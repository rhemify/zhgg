/// Prompt-aware mode classifier — Phase 17.
///
/// Lightweight Anthropic Haiku 4.5 call that scores prompt complexity 1-10
/// BEFORE the router picks `fast` vs `consensus`. Outputs a recommendation
/// the `mode-decider` may use to upgrade or downgrade the user's choice.
/// Failure-mode is fail-OPEN — if the classifier API is down, malformed,
/// or unreachable, we return a clean error and the router falls back to
/// `intent.mode` as supplied. No silent overrides.
///
/// Cost economics: with prompt-cached system prompt the marginal cost is
/// ~$0.00025/call (cache reads at $0.10/1M input tokens, 10× discount).
/// Latency adds ~1s p50 to a 5-15s loop — invisible.

import type { Mode } from './intent.js';

export interface ClassifierResult {
  /// Complexity score 1 (trivial) → 10 (critical / multi-step reasoning)
  score: number;
  /// Mode the classifier recommends. Caller may ignore in low-confidence
  /// situations.
  recommended: Mode;
  /// 0..1 — how confident the classifier is in its recommendation.
  /// `mode-decider` enforces a `>= 0.7` threshold before overriding the
  /// user's chosen mode.
  confidence: number;
}

export type ClassifierError =
  | { kind: 'not_configured' }
  | { kind: 'transport'; reason: string }
  | { kind: 'malformed'; reason: string };

export type ClassifierOutcome =
  | { ok: true; value: ClassifierResult }
  | { ok: false; error: ClassifierError };

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface ClassifierOptions {
  /// Anthropic API key — `sk-ant-...`. When undefined, classifier
  /// returns `not_configured` and caller falls back to user-supplied
  /// mode (matches the project-wide fail-open pattern).
  apiKey?: string;
  /// Override base URL for tests / proxies. Defaults to Anthropic's
  /// production endpoint.
  endpoint?: string;
  /// Pluggable fetch — tests pass a stub. Default: global `fetch`.
  fetchImpl?: FetchLike;
  /// Override the model. Defaults to Haiku 4.5 (fast + cheap + cached).
  model?: string;
}

const DEFAULT_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

/// System prompt — kept stable so prompt-caching kicks in (10× cost
/// discount on cache hits). Bumping this string invalidates the cache.
const SYSTEM_PROMPT = `You are a lightweight prompt-complexity classifier for the zhgg agent router.

Given an incoming prompt, score it 1-10 on reasoning depth + risk:

  1-2: trivial (greetings, simple lookups, single-step arithmetic)
  3-4: simple (one-shot factual answers, basic transforms)
  5-6: moderate (multi-step reasoning, code review, summaries)
  7-8: hard (smart contract logic, multi-source synthesis, ambiguous intents)
  9-10: critical (novel exploits, regulatory analysis, financial decisions where one mistake compounds)

Recommend a mode based on the score:

  score 1-3 → "fast"        (one provider, lowest cost)
  score 4-6 → "verified"    (one provider with TEE attestation)
  score 7-10 → "consensus"  (3 providers, majority vote, audit-grade)

Output exactly this JSON, with no preamble or trailing text:

  {"score": <int 1-10>, "recommended": "fast"|"verified"|"consensus", "confidence": <float 0..1>}

Confidence is your certainty in the score; use < 0.7 when the prompt is ambiguous between two adjacent tiers.`;

/// Classify a prompt's complexity. Returns a Result-shaped outcome so
/// callers can destructure cleanly without exception handling on the
/// hot path.
export async function classifyComplexity(
  prompt: string,
  opts: ClassifierOptions = {}
): Promise<ClassifierOutcome> {
  if (!opts.apiKey) return { ok: false, error: { kind: 'not_configured' } };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const model = opts.model ?? DEFAULT_MODEL;

  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 100,
        // Prompt caching — cache_control on the system block enables
        // the 10× input-token discount on subsequent calls. The system
        // prompt MUST stay byte-stable for cache hits.
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          {
            role: 'user',
            content: prompt.slice(0, 4000), // hard cap to keep cost predictable
          },
        ],
      }),
    });
  } catch (e) {
    return {
      ok: false,
      error: { kind: 'transport', reason: e instanceof Error ? e.message : String(e) },
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      error: { kind: 'transport', reason: `Anthropic returned HTTP ${res.status}` },
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    return {
      ok: false,
      error: { kind: 'malformed', reason: e instanceof Error ? e.message : String(e) },
    };
  }

  // Anthropic's content array — extract the first text block.
  const text = extractText(body);
  if (!text) {
    return {
      ok: false,
      error: { kind: 'malformed', reason: 'no text content in response' },
    };
  }

  const parsed = parseClassifierJson(text);
  if (!parsed.ok) return parsed;

  return { ok: true, value: parsed.value };
}

function extractText(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      return (block as { text: string }).text;
    }
  }
  return null;
}

function parseClassifierJson(text: string): ClassifierOutcome {
  // Strip code fences if the model wrapped the JSON.
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let raw: unknown;
  try {
    raw = JSON.parse(stripped);
  } catch (e) {
    return {
      ok: false,
      error: {
        kind: 'malformed',
        reason: `not JSON: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }

  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: { kind: 'malformed', reason: 'response not an object' } };
  }
  const score = (raw as { score?: unknown }).score;
  const recommended = (raw as { recommended?: unknown }).recommended;
  const confidence = (raw as { confidence?: unknown }).confidence;

  if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 10) {
    return {
      ok: false,
      error: { kind: 'malformed', reason: `score not int 1..10: ${String(score)}` },
    };
  }
  if (recommended !== 'fast' && recommended !== 'verified' && recommended !== 'consensus') {
    return {
      ok: false,
      error: {
        kind: 'malformed',
        reason: `recommended not in {fast,verified,consensus}: ${String(recommended)}`,
      },
    };
  }
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    return {
      ok: false,
      error: {
        kind: 'malformed',
        reason: `confidence not 0..1: ${String(confidence)}`,
      },
    };
  }

  return {
    ok: true,
    value: {
      score,
      recommended: recommended as Mode,
      confidence,
    },
  };
}
