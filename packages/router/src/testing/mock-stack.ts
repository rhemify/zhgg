// Mock router stack for demos, integration smoke tests, and TUI development.
// NOT for unit tests — those should mock individual adapters/keepers/audit
// directly. This module is a "press play and see the whole thing run" helper.

import { createPool } from '../pool.js';
import { createRouter, type Router } from '../router.js';
import { createAuditWriter, type AuditStorageBackend, type AuditWriter } from '../audit.js';
import type { InferenceAdapter } from '../adapters/types.js';
import type {
  Adapter,
  InferenceResult,
  Provider,
} from '../intent.js';
import type { ExecutionScope } from '../scope.js';
import type { KeeperClient } from '../keeper.js';

/** Deterministic 32-byte hex root derived from a provider id. */
function teeRootFor(providerId: string): string {
  let hash = 0;
  for (let i = 0; i < providerId.length; i++) {
    hash = (hash * 31 + providerId.charCodeAt(i)) >>> 0;
  }
  const seed = hash.toString(16).padStart(8, '0');
  return '0x' + seed.repeat(8);
}

/** Headline → categorical sentiment mapping used by demo and TUI. */
export function classifyHeadline(prompt: string): string {
  const p = prompt.toLowerCase();
  if (p.includes('fall') || p.includes('tariff')) return 'bearish';
  if (p.includes('hold') || p.includes('caution')) return 'neutral';
  if (p.includes('surge') || p.includes('passes') || p.includes('allocate')) return 'bullish';
  return 'neutral';
}

interface MockAdapterOptions {
  id: 'zg' | 'x402';
  tee: boolean;
  providers: Provider[];
  responder: (provider: Provider, prompt: string) => string;
  /** Artificial latency in ms — useful for TUI animations. Default 0. */
  delayMs?: number;
}

function buildMockAdapter(opts: MockAdapterOptions): InferenceAdapter {
  return {
    id: opts.id,
    capabilities: { tee: opts.tee },
    async listProviders() {
      return opts.providers;
    },
    async infer(provider: Provider, prompt: string) {
      if (opts.delayMs && opts.delayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      const result: InferenceResult = {
        response: opts.responder(provider, prompt),
        cost_usd: provider.price_per_call_usd,
        latency_ms: provider.latency_p50_ms,
        attestation_root: opts.tee ? teeRootFor(provider.id) : null,
        receipt: `rcpt-${provider.id}-${Date.now()}`,
        provider_id: provider.id,
      };
      return { ok: true as const, value: result };
    },
  };
}

function buildMockKeeper(): KeeperClient {
  let nonce = 0;
  return {
    async settle() {
      nonce += 1;
      const hex = nonce.toString(16).padStart(64, '0');
      return { ok: true, value: { txHash: '0x' + hex, confirmed: true } };
    },
    async close() {
      /* noop */
    },
  };
}

function buildMockStorage(): AuditStorageBackend {
  let n = 0;
  return {
    async upload() {
      n += 1;
      return '0x' + n.toString(16).padStart(64, '0');
    },
  };
}

export interface MockStack {
  router: Router;
  audit: AuditWriter;
  scope: ExecutionScope;
  adapters: ReadonlyMap<Adapter, InferenceAdapter>;
}

export interface BuildMockStackOptions {
  /** Provider responder. Default: classifyHeadline. */
  responder?: (provider: Provider, prompt: string) => string;
  /** Artificial inference delay (ms). Default 0; the TUI uses ~120ms. */
  delayMs?: number;
  /** Override scope. Defaults are permissive — fine for demos, tighten in prod. */
  scope?: Partial<ExecutionScope>;
  /** iNFT token id used for audit attribution. Default '1'. */
  agentInftId?: string;
}

const DEFAULT_X402_PROVIDERS: Provider[] = [
  { id: 'x402:groq', model: 'mixtral-8x7b', tee: false, price_per_call_usd: 0.00008, latency_p50_ms: 280, adapter: 'x402' },
  { id: 'x402:together', model: 'llama-3-70b', tee: false, price_per_call_usd: 0.0001, latency_p50_ms: 340, adapter: 'x402' },
  { id: 'x402:fireworks', model: 'qwen2.5-72b', tee: false, price_per_call_usd: 0.00012, latency_p50_ms: 310, adapter: 'x402' },
];

const DEFAULT_ZG_PROVIDERS: Provider[] = [
  { id: 'zg:0xnode-a', model: 'qwen3-7b', tee: true, price_per_call_usd: 0.0003, latency_p50_ms: 1500, adapter: 'zg' },
  { id: 'zg:0xnode-b', model: 'glm-5-fp8', tee: true, price_per_call_usd: 0.0004, latency_p50_ms: 1700, adapter: 'zg' },
];

/**
 * Build a fully-wired router stack with mocked adapters, keeper, and storage.
 * Demo agents and TUIs use this so judges can run `bun run demo` / `bun run router`
 * without testnet credentials, while keeping the production code paths intact.
 *
 * The default responder produces 'bullish' for headline #5 ("upgrade proposal")
 * across most providers but `zg:0xnode-a` deviates to 'neutral' — this surfaces
 * the consensus-mode `low_confidence` flag, which is the most judge-visible
 * feature of the architecture.
 */
export function buildMockStack(opts: BuildMockStackOptions = {}): MockStack {
  const responder = opts.responder ?? defaultResponder;
  const delayMs = opts.delayMs ?? 0;

  const x402Adapter = buildMockAdapter({
    id: 'x402',
    tee: false,
    providers: DEFAULT_X402_PROVIDERS,
    responder,
    delayMs,
  });
  const zgAdapter = buildMockAdapter({
    id: 'zg',
    tee: true,
    providers: DEFAULT_ZG_PROVIDERS,
    responder,
    delayMs,
  });

  const adapters = new Map<Adapter, InferenceAdapter>([
    ['x402', x402Adapter],
    ['zg', zgAdapter],
  ]);
  const pool = createPool([x402Adapter, zgAdapter]);
  const keeper = buildMockKeeper();
  const audit = createAuditWriter({
    storage: buildMockStorage(),
    flushIntervalMs: 60_000,
  });
  const scope: ExecutionScope = {
    allowedModes: ['fast', 'verified', 'consensus', 'pipeline'],
    maxCostUsd: 0.05,
    maxLatencyMs: 10_000,
    ttlMs: 60_000,
    expiresAt: Date.now() + 60_000,
    ...opts.scope,
  };
  const router = createRouter({
    pool,
    adapters,
    keeper,
    audit,
    agentInftId: opts.agentInftId ?? '1',
  });

  return { router, audit, scope, adapters };
}

function defaultResponder(provider: Provider, prompt: string): string {
  // zg:0xnode-a deviates on "upgrade proposal" → triggers consensus low_confidence.
  if (
    provider.id === 'zg:0xnode-a' &&
    prompt.toLowerCase().includes('upgrade proposal')
  ) {
    return 'neutral';
  }
  return classifyHeadline(prompt);
}
