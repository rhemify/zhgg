/// Resolves a transfer recipient to a real address.
///
/// Two input shapes:
///   - `0x` + 40 hex          → checksummed via viem's `getAddress`.
///   - `<name>.eth`           → mainnet ENS lookup via viem's
///                              `getEnsAddress`. Requires a mainnet RPC
///                              (env: `ENS_RPC_URL` or fallback public
///                              endpoint). Returns an error if no record
///                              exists for the name.
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
  /// Mainnet RPC for ENS lookups. Defaults to `https://eth.llamarpc.com`
  /// when `ENS_RPC_URL` is unset. Public endpoints are rate-limited but
  /// fine for hackathon-scale usage.
  ensRpcUrl?: string;
}

const DEFAULT_ENS_RPC = 'https://eth.llamarpc.com';

let cachedMainnet: PublicClient | null = null;
function mainnetClient(rpcUrl: string): PublicClient {
  if (cachedMainnet) return cachedMainnet;
  cachedMainnet = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  });
  return cachedMainnet;
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
    const rpcUrl = opts.ensRpcUrl ?? process.env.ENS_RPC_URL ?? DEFAULT_ENS_RPC;
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
    const client = mainnetClient(rpcUrl);
    let resolved: Address | null;
    try {
      resolved = await client.getEnsAddress({ name: normalized });
    } catch (e) {
      // Classify between "name doesn't exist / no resolver" (caller's
      // problem) vs "RPC unreachable" (infra problem). viem throws
      // ContractFunctionExecutionError when the resolver call reverts —
      // that's typically a non-existent name on UniversalResolver, not
      // a network issue.
      const msg = e instanceof Error ? e.message : String(e);
      const looksLikeNoSuchName =
        /reverted|resolver|not.*found|no record|0x0{40}/i.test(msg);
      return {
        ok: false,
        error: looksLikeNoSuchName
          ? {
              kind: 'ens_unresolved',
              reason: `${trimmed} — name does not exist or has no addr record (mainnet)`,
            }
          : {
              kind: 'ens_lookup_failed',
              reason: `mainnet ENS lookup via ${rpcUrl} failed: ${msg.slice(0, 200)}`,
            },
      };
    }
    if (resolved === null) {
      return {
        ok: false,
        error: {
          kind: 'ens_unresolved',
          reason: `${trimmed} has no on-chain ENS address record on mainnet`,
        },
      };
    }
    return { ok: true, address: resolved, source: 'ens' };
  }

  return {
    ok: false,
    error: {
      kind: 'invalid_recipient',
      reason: `expected 0x-address or *.eth name, got "${trimmed}"`,
    },
  };
}
