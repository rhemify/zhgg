/// Thin fetch wrapper around the KeeperHub REST surface.
///
/// Hard rules:
///   - The `kh_` bearer NEVER appears in any error message, log line, or
///     thrown payload. We read it once from `KH_API_KEY` (or the
///     explicit `apiKey` arg the test harness passes), inject it into
///     the `Authorization` header, and never echo it back.
///   - 4xx/5xx responses surface as `{ ok: false, error: { kind, ... } }`
///     — never thrown — so the executor can map them to typed error
///     kinds instead of a generic try/catch. The status code + a body
///     excerpt come along for diagnosis.
///   - Non-JSON responses (HTML error pages, gateway timeouts) become
///     `malformed_response`. We slice the body to 240 chars so a giant
///     CDN error page doesn't wreck the audit trail.
///
/// The base URL defaults to the KH SaaS host but is overridable via
/// `KEEPERHUB_API_URL` for self-hosted / staging envs.

import type { KHResult, KHError } from './index.js';

export const KH_DEFAULT_BASE_URL = 'https://app.keeperhub.com';

/// The fetch shape we depend on. Bun's global `fetch` matches this; the
/// test harness substitutes a mock with the same surface.
export type KHFetch = (input: string, init?: KHFetchInit) => Promise<KHFetchResponse>;

export interface KHFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface KHFetchResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
}

export interface KHClientConfig {
  apiKey: string;
  baseUrl?: string;
  /// Inject a custom fetch (for the test harness). Defaults to the
  /// global `fetch` Bun provides.
  fetchImpl?: KHFetch;
}

export interface KHClient {
  /// Issue a GET. `path` must start with `/api/...`. `query` keys with
  /// `undefined` values are dropped so callers can pass optional filters
  /// without manually building URL strings.
  get<T>(path: string, query?: Record<string, string | undefined>): Promise<KHResult<T>>;
  post<T>(path: string, body: unknown): Promise<KHResult<T>>;
}

export function createKHClient(cfg: KHClientConfig): KHClient {
  if (typeof cfg.apiKey !== 'string' || cfg.apiKey.length === 0) {
    // Defensive: callers go through `executeKHCall` which has its own
    // env check, but if anything bypasses that we still refuse rather
    // than firing an unauthenticated request.
    throw new Error('KH client constructed without apiKey');
  }
  const baseUrl = (cfg.baseUrl ?? KH_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchImpl: KHFetch = cfg.fetchImpl ?? (globalThis.fetch as unknown as KHFetch);
  const apiKey = cfg.apiKey;

  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: { query?: Record<string, string | undefined>; body?: unknown },
  ): Promise<KHResult<T>> {
    if (!path.startsWith('/')) {
      return err({ kind: 'bad_request', reason: `path must start with "/", got "${path}"` });
    }
    let url = baseUrl + path;
    if (opts.query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (typeof v === 'string' && v.length > 0) params.append(k, v);
      }
      const qs = params.toString();
      if (qs.length > 0) url += '?' + qs;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      try {
        body = JSON.stringify(opts.body);
      } catch (e) {
        return err({
          kind: 'bad_request',
          reason: `cannot serialise request body: ${(e as Error).message}`,
        });
      }
    }

    let res: KHFetchResponse;
    try {
      res = await fetchImpl(url, { method, headers, body });
    } catch (e) {
      return err({
        kind: 'network',
        reason: (e as Error).message,
      });
    }

    let raw: string;
    try {
      raw = await res.text();
    } catch (e) {
      return err({
        kind: 'malformed_response',
        status: res.status,
        reason: `cannot read response body: ${(e as Error).message}`,
      });
    }

    if (!res.ok) {
      // Bubble the HTTP status + body excerpt verbatim. Don't try to
      // pretty-print — the operator wants to see exactly what KH said.
      return err({
        kind: res.status === 401 || res.status === 403 ? 'unauthorized'
            : res.status === 404 ? 'not_found'
            : res.status === 422 ? 'unprocessable'
            : res.status >= 500 ? 'server_error'
            : 'http_error',
        status: res.status,
        reason: raw.slice(0, 240) || `HTTP ${res.status}`,
      });
    }

    if (raw.length === 0) {
      // 204 No Content / empty 200 — let callers parse defensively if
      // they care; otherwise return the empty object so generic typed
      // reads don't crash on `.executionId`.
      return ok({} as T);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return err({
        kind: 'malformed_response',
        status: res.status,
        reason: `non-JSON body (excerpt): ${raw.slice(0, 240)} — ${(e as Error).message}`,
      });
    }

    return ok(parsed as T);
  }

  return {
    get: (path, query) => request('GET', path, { query }),
    post: (path, body) => request('POST', path, { body }),
  };
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function err(error: KHError): { ok: false; error: KHError } {
  return { ok: false, error };
}
