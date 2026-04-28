import { LRUCache } from 'lru-cache';
import {
  adapterError,
  type AdapterError,
  type InferenceAdapter,
} from './types.js';
import type { Provider, InferenceResult } from '../intent.js';
import type { Result } from '../result.js';

const DEFAULT_BAZAAR_URL =
  'https://api.cdp.coinbase.com/platform/v2/x402/discovery/search';
const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_CACHE_MAX = 50;
const DEFAULT_LATENCY_MS = 500;

export type PayRequest = (
  url: string,
  init: RequestInit,
) => Promise<{ response: Response; receipt: string }>;

export interface X402AdapterOptions {
  /** Internal only — Bazaar discovery URL. Do not expose to user input. */
  bazaarUrl?: string;
  cacheTtlMs?: number;
  cacheMax?: number;
  fetcher?: typeof fetch;
  payRequest?: PayRequest;
}

export interface BazaarService {
  id: string;
  endpoint: string;
  model: string;
  pricing: { perCallUsd: number };
  latency_p50_ms?: number;
}

export interface BazaarSearchResult {
  services: BazaarService[];
}

interface ListOpts {
  maxCostUsd?: number;
  maxLatencyMs?: number;
}

const X402_PROVIDER_ID_PREFIX = 'x402:';

export function stubPayRequest(): PayRequest {
  return async () => {
    throw new Error(
      'x402 payment not implemented in v1 — inject payRequest for live use',
    );
  };
}

function buildUrl(base: string, opts: ListOpts): string {
  const url = new URL(base);
  url.searchParams.set('q', 'inference');
  url.searchParams.set('capabilities', 'text-generation');
  if (opts.maxCostUsd !== undefined) {
    url.searchParams.set('maxUsdPrice', String(opts.maxCostUsd));
  }
  return url.toString();
}

function isBazaarSearchResult(value: unknown): value is BazaarSearchResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { services?: unknown };
  if (!Array.isArray(v.services)) return false;
  return v.services.every((s) => {
    if (typeof s !== 'object' || s === null) return false;
    const svc = s as Record<string, unknown>;
    return (
      typeof svc.id === 'string' &&
      typeof svc.endpoint === 'string' &&
      typeof svc.model === 'string' &&
      typeof svc.pricing === 'object' &&
      svc.pricing !== null &&
      typeof (svc.pricing as { perCallUsd?: unknown }).perCallUsd === 'number'
    );
  });
}

function toProvider(service: BazaarService): Provider {
  return {
    id: `${X402_PROVIDER_ID_PREFIX}${service.id}`,
    model: service.model,
    tee: false,
    price_per_call_usd: service.pricing.perCallUsd,
    latency_p50_ms: service.latency_p50_ms ?? DEFAULT_LATENCY_MS,
    adapter: 'x402',
    endpoint: service.endpoint,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function createX402Adapter(opts: X402AdapterOptions = {}): InferenceAdapter {
  const bazaarUrl = opts.bazaarUrl ?? DEFAULT_BAZAAR_URL;
  const fetcher = opts.fetcher ?? globalThis.fetch.bind(globalThis);
  const payRequest = opts.payRequest ?? stubPayRequest();
  const cache = new LRUCache<string, Provider[]>({
    max: opts.cacheMax ?? DEFAULT_CACHE_MAX,
    ttl: opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
  });

  return {
    id: 'x402',
    capabilities: { tee: false },

    async listProviders(listOpts: ListOpts = {}): Promise<Provider[]> {
      const cacheKey = JSON.stringify({
        maxCostUsd: listOpts.maxCostUsd ?? null,
        maxLatencyMs: listOpts.maxLatencyMs ?? null,
      });
      const cached = cache.get(cacheKey);
      if (cached) return cached;

      const url = buildUrl(bazaarUrl, listOpts);
      let response: Response;
      try {
        response = await fetcher(url);
      } catch {
        return [];
      }
      if (!response.ok) return [];

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        return [];
      }
      if (!isBazaarSearchResult(parsed)) return [];

      let providers = parsed.services.map(toProvider);
      if (listOpts.maxLatencyMs !== undefined) {
        const cap = listOpts.maxLatencyMs;
        providers = providers.filter((p) => p.latency_p50_ms <= cap);
      }
      providers.sort((a, b) => a.price_per_call_usd - b.price_per_call_usd);

      cache.set(cacheKey, providers);
      return providers;
    },

    async infer(
      provider: Provider,
      prompt: string,
    ): Promise<Result<InferenceResult, AdapterError>> {
      if (provider.adapter !== 'x402') {
        return adapterError(
          'wrong_adapter',
          `expected adapter 'x402', got '${provider.adapter}'`,
        );
      }
      if (!provider.id.startsWith(X402_PROVIDER_ID_PREFIX)) {
        return adapterError(
          'invalid_provider',
          `id must start with '${X402_PROVIDER_ID_PREFIX}'`,
        );
      }
      if (!provider.endpoint) {
        return adapterError('invalid_provider', 'missing endpoint');
      }

      const body = JSON.stringify({
        model: provider.model,
        messages: [{ role: 'user', content: prompt }],
      });

      const t0 = Date.now();
      let result: { response: Response; receipt: string };
      try {
        result = await payRequest(provider.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
      } catch (err) {
        return adapterError('payment_failed', errorMessage(err));
      }

      if (!result.response.ok) {
        return adapterError('transport', `status ${result.response.status}`);
      }

      let json: unknown;
      try {
        json = await result.response.json();
      } catch (err) {
        return adapterError('transport', `malformed json: ${errorMessage(err)}`);
      }

      const rawContent = (json as { choices?: Array<{ message?: { content?: unknown } }> })
        .choices?.[0]?.message?.content;
      if (typeof rawContent !== 'string' || rawContent.length === 0) {
        return adapterError('transport', 'empty or non-string response content');
      }

      return {
        ok: true,
        value: {
          response: rawContent,
          // TODO Phase 5: thread actual cost from X-PAYMENT-RESPONSE header
          // through the real payRequest. v1 uses Bazaar advertised price.
          cost_usd: provider.price_per_call_usd,
          latency_ms: Date.now() - t0,
          attestation_root: null,
          receipt: result.receipt,
          provider_id: provider.id,
        },
      };
    },
  };
}
