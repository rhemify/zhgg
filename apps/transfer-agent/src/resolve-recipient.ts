/// Resolves a transfer recipient to a real address.
///
/// Two input shapes:
///   - `0x` + 40 hex   → checksummed via viem's `getAddress` (any case
///                       accepted; non-strict EIP-55 to tolerate
///                       wallet/explorer copy-paste casing).
///   - `<name>.eth`    → mainnet ENS lookup via a chain of FREE public
///                       RPCs (no API key required). The first endpoint
///                       to return a result wins. Empirically reliable
///                       endpoints (probed live):
///                         - eth.drpc.org              (~60-250ms)
///                         - ethereum-rpc.publicnode.com (~280-380ms)
///                         - 1rpc.io/eth               (~500-950ms)
///                         - eth.llamarpc.com          (~310-820ms)
///                       Override the entire chain via `ENS_RPC_URL`
///                       (e.g. an Alchemy/Infura key) — when set, only
///                       that endpoint is used.
///
/// Anything else returns `{ ok: false, kind: 'invalid_recipient' }`.

import {
  createPublicClient,
  http,
  isAddress,
  getAddress,
  type Address,
  type PublicClient,
} from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';

export type ResolveError =
  | { kind: 'invalid_recipient'; reason: string }
  | { kind: 'ens_not_configured'; reason: string }
  | { kind: 'ens_unresolved'; reason: string }
  | { kind: 'ens_lookup_failed'; reason: string };

export type ResolveResult =
  | { ok: true; address: Address; source: 'address' | 'ens' }
  | { ok: false; error: ResolveError };

export interface ResolveOptions {
  /// Mainnet RPC override for ENS lookups. When set, only this endpoint
  /// is queried. When unset, the resolver iterates the FREE_FALLBACK_RPCS
  /// list in order (first success wins). Production deployments should
  /// set this to a paid endpoint for predictable latency; demos work
  /// with the free fallback chain.
  ensRpcUrl?: string;
}

/// Speed-ordered free public RPCs that empirically serve ENS reliably
/// without an API key. Order = fastest median first; the resolver short-
/// circuits on the first success so steady-state latency = first endpoint.
/// Reordered after live measurement; do NOT alphabetise.
const FREE_FALLBACK_RPCS: readonly string[] = [
  'https://eth.drpc.org',
  'https://ethereum-rpc.publicnode.com',
  'https://1rpc.io/eth',
  'https://eth.llamarpc.com',
];

const clientCache = new Map<string, PublicClient>();
function mainnetClient(rpcUrl: string): PublicClient {
  const cached = clientCache.get(rpcUrl);
  if (cached) return cached;
  const client = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl, { timeout: 5_000 }),
  });
  clientCache.set(rpcUrl, client);
  return client;
}

export async function resolveRecipient(
  raw: string,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: { kind: 'invalid_recipient', reason: 'empty' } };
  }

  // strict:false → accepts any 40-hex regardless of case. Mixed-case
  // addresses still get checksum-normalised below via getAddress; we
  // just don't reject the user for casing typos a wallet copy-paste
  // can introduce.
  if (isAddress(trimmed, { strict: false })) {
    return { ok: true, address: getAddress(trimmed), source: 'address' };
  }

  if (/\.eth$/i.test(trimmed)) {
    let normalized: string;
    try {
      normalized = normalize(trimmed.toLowerCase());
    } catch (e) {
      return {
        ok: false,
        error: {
          kind: 'invalid_recipient',
          reason: `ENS normalisation failed for "${trimmed}": ${e instanceof Error ? e.message : String(e)}`,
        },
      };
    }

    // Build the RPC chain: explicit override (if any) first; otherwise
    // iterate the speed-ordered free fallback list. First success wins;
    // we only return ens_unresolved (a "user gave a bad name" error) on
    // the FIRST endpoint that surfaces a definitive revert — endpoints
    // that themselves fail with infra errors get retried via the next
    // entry in the chain.
    const explicitOverride = opts.ensRpcUrl ?? process.env.ENS_RPC_URL;
    const rpcChain: readonly string[] = explicitOverride
      ? [explicitOverride]
      : FREE_FALLBACK_RPCS;

    const failures: string[] = [];
    let definitiveUnresolved: string | null = null;

    for (const rpcUrl of rpcChain) {
      const client = mainnetClient(rpcUrl);
      try {
        const resolved = await client.getEnsAddress({ name: normalized });
        if (resolved !== null) {
          return { ok: true, address: resolved, source: 'ens' };
        }
        // null = resolver returned 0x0 → name has no addr record. This
        // is definitive (the resolver is reachable and answered), no
        // need to try other RPCs.
        definitiveUnresolved = `${trimmed} has no on-chain ENS address record on mainnet`;
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // A revert on UniversalResolver typically means "no resolver
        // for this name" — also definitive, no need to fall through.
        if (/reverted|no resolver|not.*found|no record|0x0{40}/i.test(msg)) {
          definitiveUnresolved = `${trimmed} — name does not exist or has no addr record (mainnet)`;
          break;
        }
        // Otherwise infra error (timeout, malformed JSON, rate limit).
        // Record it and try the next endpoint.
        failures.push(`${rpcUrl}: ${msg.slice(0, 80)}`);
      }
    }

    if (definitiveUnresolved !== null) {
      return { ok: false, error: { kind: 'ens_unresolved', reason: definitiveUnresolved } };
    }
    return {
      ok: false,
      error: {
        kind: 'ens_lookup_failed',
        reason: `all ${rpcChain.length} RPC(s) failed; last errors: ${failures.slice(-3).join(' | ')}`,
      },
    };
  }

  return {
    ok: false,
    error: {
      kind: 'invalid_recipient',
      reason: `expected 0x-address or *.eth name, got "${trimmed}"`,
    },
  };
}
