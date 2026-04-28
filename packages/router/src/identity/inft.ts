import { LRUCache } from 'lru-cache';
import {
  loadEnv,
  requireAgentNftAddress,
  requireZgKey,
  ZG_GALILEO_CHAIN_ID,
} from '../constants.js';
import type { Result } from '../result.js';

export interface CapabilityManifest {
  /** Raw bytes returned by AgentNFT.capabilities(tokenId). */
  raw: string;
  /** Allowed inference modes parsed from the manifest, if encoded as JSON. */
  allowedModes: string[];
  /** Max cost in USD per request, if present. */
  maxCostUsd: number | null;
  /** Max latency in ms, if present. */
  maxLatencyMs: number | null;
}

export interface InftAuthorizeUsageInput {
  tokenId: string;
  intentHash: string;     // 0x-prefixed 32-byte hex
  royaltyValue: bigint;   // wei to attach to the call
}

export type InftError =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'malformed_capabilities'; reason: string }
  | { kind: 'transport'; reason: string }
  | { kind: 'unauthorized'; reason: string };

/** Minimal interface satisfied by both ethers v5 Contract instances and test stubs. */
export interface InftContractLike {
  ownerOf(tokenId: bigint): Promise<string>;
  capabilities(tokenId: bigint): Promise<string>;
  memoryRoot(tokenId: bigint): Promise<string>;
  updateMemoryRoot(tokenId: bigint, storageRoot: string): Promise<{ wait(): Promise<unknown> }>;
  authorizeUsage(
    tokenId: bigint,
    intentHash: string,
    overrides: { value: bigint },
  ): Promise<{ wait(): Promise<unknown> }>;
}

export interface InftAdapter {
  readCapabilities(tokenId: string): Promise<Result<CapabilityManifest, InftError>>;
  updateMemoryRoot(tokenId: string, storageRoot: string): Promise<Result<string, InftError>>;
  authorizeUsage(input: InftAuthorizeUsageInput): Promise<Result<string, InftError>>;
  ownerOf(tokenId: string): Promise<Result<string, InftError>>;
  /** Diagnostic: clear the in-process cache. */
  invalidate(): void;
}

export interface InftAdapterOptions {
  rpcUrl?: string;
  privateKey?: string;
  contractAddress?: string;
  capabilitiesCacheTtlMs?: number;
  capabilitiesCacheMax?: number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_CACHE_MAX = 100;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// keccak256("NotTokenOwner(uint256,address)").slice(0,10) — first 4 bytes of
// the custom-error selector. ethers v5 surfaces custom errors as either a
// decoded `errorName` or as a hex-encoded `data` field; check both.
const NOT_TOKEN_OWNER_SELECTOR = '0x6d3d1858';

function isUnauthorizedError(err: unknown, reason: string): boolean {
  if (reason.toLowerCase().includes('owner') || reason.toLowerCase().includes('unauthorized')) {
    return true;
  }
  if (typeof err === 'object' && err !== null) {
    const e = err as { errorName?: unknown; data?: unknown };
    if (typeof e.errorName === 'string' && e.errorName === 'NotTokenOwner') return true;
    if (typeof e.data === 'string' && e.data.toLowerCase().startsWith(NOT_TOKEN_OWNER_SELECTOR)) {
      return true;
    }
  }
  return false;
}

function parseCapabilityManifest(raw: string): CapabilityManifest {
  // The manifest is stored as raw bytes by AgentNFT. v1 convention: UTF-8
  // encoded JSON. If it's not parseable as JSON, return the raw bytes with
  // empty allowed modes — capability gating happens upstream in the policy.
  let allowedModes: string[] = [];
  let maxCostUsd: number | null = null;
  let maxLatencyMs: number | null = null;
  try {
    const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
    if (hex.length > 0 && hex.length % 2 === 0) {
      const bytes = Buffer.from(hex, 'hex');
      const json = bytes.toString('utf8');
      const parsed = JSON.parse(json) as Record<string, unknown>;
      if (Array.isArray(parsed['allowedModes'])) {
        allowedModes = parsed['allowedModes'].filter((m): m is string => typeof m === 'string');
      }
      if (typeof parsed['maxCostUsd'] === 'number') {
        maxCostUsd = parsed['maxCostUsd'];
      }
      if (typeof parsed['maxLatencyMs'] === 'number') {
        maxLatencyMs = parsed['maxLatencyMs'];
      }
    }
  } catch {
    // Non-JSON manifest is acceptable — return defaults.
  }
  return { raw, allowedModes, maxCostUsd, maxLatencyMs };
}

/**
 * Test seam: build an adapter directly from a contract-like dependency.
 * Production wiring lives in `createInftAdapter()` which lazy-imports ethers v5.
 */
export function createInftAdapterFromContract(
  contract: InftContractLike,
  opts: { capabilitiesCacheTtlMs?: number; capabilitiesCacheMax?: number } = {},
): InftAdapter {
  const cache = new LRUCache<string, CapabilityManifest>({
    max: opts.capabilitiesCacheMax ?? DEFAULT_CACHE_MAX,
    ttl: opts.capabilitiesCacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
  });

  return {
    async readCapabilities(tokenId: string): Promise<Result<CapabilityManifest, InftError>> {
      const cached = cache.get(tokenId);
      if (cached !== undefined) return { ok: true, value: cached };
      let raw: string;
      try {
        raw = await contract.capabilities(BigInt(tokenId));
      } catch (err) {
        return { ok: false, error: { kind: 'transport', reason: errorMessage(err) } };
      }
      const manifest = parseCapabilityManifest(raw);
      cache.set(tokenId, manifest);
      return { ok: true, value: manifest };
    },

    async ownerOf(tokenId: string): Promise<Result<string, InftError>> {
      try {
        const owner = await contract.ownerOf(BigInt(tokenId));
        return { ok: true, value: owner };
      } catch (err) {
        return { ok: false, error: { kind: 'transport', reason: errorMessage(err) } };
      }
    },

    async updateMemoryRoot(
      tokenId: string,
      storageRoot: string,
    ): Promise<Result<string, InftError>> {
      try {
        const tx = await contract.updateMemoryRoot(BigInt(tokenId), storageRoot);
        await tx.wait();
        // Invalidate cache for this token — capabilities/memory may have shifted.
        cache.delete(tokenId);
        return { ok: true, value: storageRoot };
      } catch (err) {
        const reason = errorMessage(err);
        if (isUnauthorizedError(err, reason)) {
          return { ok: false, error: { kind: 'unauthorized', reason } };
        }
        return { ok: false, error: { kind: 'transport', reason } };
      }
    },

    async authorizeUsage(
      input: InftAuthorizeUsageInput,
    ): Promise<Result<string, InftError>> {
      try {
        const tx = await contract.authorizeUsage(BigInt(input.tokenId), input.intentHash, {
          value: input.royaltyValue,
        });
        await tx.wait();
        return { ok: true, value: input.intentHash };
      } catch (err) {
        return { ok: false, error: { kind: 'transport', reason: errorMessage(err) } };
      }
    },

    invalidate(): void {
      cache.clear();
    },
  };
}

const AGENT_NFT_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function capabilities(uint256 tokenId) view returns (bytes)',
  'function memoryRoot(uint256 tokenId) view returns (bytes32)',
  'function updateMemoryRoot(uint256 tokenId, bytes32 storageRoot)',
  'function authorizeUsage(uint256 tokenId, bytes32 intentHash) payable',
];

/** Production factory — lazy-imports ethers v5. */
export async function createInftAdapter(
  opts: InftAdapterOptions = {},
): Promise<InftAdapter> {
  const env = loadEnv();
  const rpcUrl = opts.rpcUrl ?? env.ZG_RPC_URL;
  const privateKey = opts.privateKey ?? requireZgKey(env);
  const contractAddress = opts.contractAddress ?? requireAgentNftAddress(env);

  const ethers = await import('ethers');
  const ethersAny = ethers as unknown as {
    providers: { JsonRpcProvider: new (url: string) => unknown };
    Wallet: new (key: string, provider: unknown) => unknown;
    Contract: new (address: string, abi: unknown, signerOrProvider: unknown) => InftContractLike;
  };
  const provider = new ethersAny.providers.JsonRpcProvider(rpcUrl);
  const wallet = new ethersAny.Wallet(privateKey, provider);
  const contract = new ethersAny.Contract(contractAddress, AGENT_NFT_ABI, wallet);

  return createInftAdapterFromContract(contract, {
    capabilitiesCacheTtlMs: opts.capabilitiesCacheTtlMs,
    capabilitiesCacheMax: opts.capabilitiesCacheMax,
  });
}

// ---------------------------------------------------------------------------
// ERC-8004 soft gate
// ---------------------------------------------------------------------------

export interface Erc8004Check {
  registered: boolean;
  reason: string;
}

/**
 * ERC-8004 soft gate: warn-and-proceed.
 * 0G Galileo testnet does not have an ERC-8004 identity registry deployed at
 * the time of this build. Callers can still gate manually if they want.
 *
 * v1 always returns `{ registered: false, reason: 'erc8004 not deployed on 0g galileo' }`.
 * Phase 5+ may wire a real read once the registry is published.
 */
export function checkErc8004(_agentAddress: string): Erc8004Check {
  return {
    registered: false,
    reason: `erc8004 not deployed on chain ${ZG_GALILEO_CHAIN_ID}; soft-gate accepts all`,
  };
}
