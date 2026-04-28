// ENS text-record agent resolver. Stretch goal for the ENS Creative track.
//
// An iNFT agent advertises its capabilities through ENS text records on a
// human-readable name (e.g. `agent.zhgg.eth`). Anyone — wallet, indexer,
// other agent — can resolve that name and discover where the iNFT lives,
// what trust levels it accepts, and what its owner-declared cost ceiling is.
//
// This bridges human-readable identity (ENS) with machine-readable
// permissions (the iNFT capability manifest), without coupling agents to
// any particular discovery layer.
//
// Text record convention:
//   zhgg.inft        = "<chainId>:<contractAddress>:<tokenId>"
//                      e.g. "16602:0xAbC…:1"
//   zhgg.modes       = "fast,verified,consensus" (comma-separated whitelist)
//   zhgg.maxCostUsd  = "0.005"
//   zhgg.maxLatencyMs= "5000"
//
// All records are optional — `zhgg.inft` is the only one required for a
// successful resolve. The rest fall back to permissive defaults if absent.

import type { Result } from '../result.js';

export interface EnsAgent {
  ensName: string;
  inft: {
    chainId: number;
    contractAddress: string;
    tokenId: string;
  };
  allowedModes: string[];
  maxCostUsd: number | null;
  maxLatencyMs: number | null;
}

export type EnsError =
  | { kind: 'no_resolver'; reason: string }
  | { kind: 'missing_inft'; reason: string }
  | { kind: 'malformed'; reason: string }
  | { kind: 'transport'; reason: string };

/** Minimal interface satisfied by ethers v5 / v6 resolvers and test stubs. */
export interface EnsResolverLike {
  /**
   * Returns the text record value, or null/empty if unset.
   * Matches ethers' `resolver.getText(key)` shape.
   */
  getText(key: string): Promise<string | null>;
}

export interface EnsProviderLike {
  /** Returns a resolver for `name`, or null if no resolver record is set. */
  getResolver(name: string): Promise<EnsResolverLike | null>;
}

const ZHGG_RECORD = {
  inft: 'zhgg.inft',
  modes: 'zhgg.modes',
  maxCostUsd: 'zhgg.maxCostUsd',
  maxLatencyMs: 'zhgg.maxLatencyMs',
} as const;

const VALID_MODES = ['fast', 'verified', 'consensus', 'pipeline'];
const INFT_RE = /^(\d+):(0x[a-fA-F0-9]{40}):(\d+)$/;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Resolve an ENS name to its iNFT-backed agent record.
 * Returns Result.error on missing resolver, missing zhgg.inft record,
 * malformed values, or transport failure.
 */
export async function resolveEnsAgent(
  ensName: string,
  provider: EnsProviderLike,
): Promise<Result<EnsAgent, EnsError>> {
  let resolver: EnsResolverLike | null;
  try {
    resolver = await provider.getResolver(ensName);
  } catch (err) {
    return { ok: false, error: { kind: 'transport', reason: errorMessage(err) } };
  }
  if (resolver === null) {
    return {
      ok: false,
      error: { kind: 'no_resolver', reason: `no resolver set for ${ensName}` },
    };
  }

  const [inftRaw, modesRaw, costRaw, latencyRaw] = await Promise.all([
    safeText(resolver, ZHGG_RECORD.inft),
    safeText(resolver, ZHGG_RECORD.modes),
    safeText(resolver, ZHGG_RECORD.maxCostUsd),
    safeText(resolver, ZHGG_RECORD.maxLatencyMs),
  ]);

  if (!inftRaw) {
    return {
      ok: false,
      error: {
        kind: 'missing_inft',
        reason: `${ensName} has no '${ZHGG_RECORD.inft}' text record`,
      },
    };
  }

  const inftMatch = INFT_RE.exec(inftRaw);
  if (inftMatch === null) {
    return {
      ok: false,
      error: {
        kind: 'malformed',
        reason: `'${ZHGG_RECORD.inft}' must be 'chainId:address:tokenId', got '${inftRaw}'`,
      },
    };
  }
  const [, chainStr, contractAddress, tokenId] = inftMatch;

  return {
    ok: true,
    value: {
      ensName,
      inft: {
        chainId: Number(chainStr),
        contractAddress: contractAddress!,
        tokenId: tokenId!,
      },
      allowedModes: parseModes(modesRaw),
      maxCostUsd: parseNumber(costRaw),
      maxLatencyMs: parseNumber(latencyRaw),
    },
  };
}

async function safeText(resolver: EnsResolverLike, key: string): Promise<string | null> {
  try {
    const v = await resolver.getText(key);
    if (v === null || v === undefined || v.length === 0) return null;
    return v;
  } catch {
    return null;
  }
}

function parseModes(raw: string | null): string[] {
  if (raw === null) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => VALID_MODES.includes(s));
}

function parseNumber(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ── Production factory using ethers v5 ────────────────────────────────────────

export interface CreateEnsResolverOptions {
  rpcUrl: string;
}

/**
 * Lazy ethers v5 mainnet ENS provider. Returns an EnsProviderLike adapter so
 * callers can compose it with `resolveEnsAgent()` without depending on ethers
 * directly.
 */
export async function createMainnetEnsProvider(
  opts: CreateEnsResolverOptions,
): Promise<EnsProviderLike> {
  const ethers = await import('ethers');
  const ethersAny = ethers as unknown as {
    providers: { JsonRpcProvider: new (url: string) => unknown };
  };
  const provider = new ethersAny.providers.JsonRpcProvider(opts.rpcUrl) as unknown as {
    getResolver(name: string): Promise<EnsResolverLike | null>;
  };
  return {
    async getResolver(name: string) {
      return provider.getResolver(name);
    },
  };
}
