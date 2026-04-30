/// Mint-agent steps — deploy state changes for one new agent.
///
/// Each step is a pure function from (executor, args) → Promise<Result>.
/// The executor abstracts viem's `simulateContract` + `writeContract` so
/// tests can pass a mock without standing up a chain. Production wraps a
/// real WalletClient + PublicClient pair in `index.ts`.
///
/// All four steps must succeed for the agent to be live. Failures bubble
/// up as a discriminated `MintError`; the CLI prints which step failed
/// and exits non-zero.

import type { Address, Hex } from 'viem';

type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export type MintError =
  | { kind: 'mint'; reason: string }
  | { kind: 'register'; reason: string }
  | { kind: 'ens'; reason: string }
  | { kind: 'spend_cap'; reason: string };

export interface MintExecutor {
  /// Simulate a contract call to get its return value, then submit the
  /// transaction. Returns the simulated result plus the actual tx hash.
  /// Throws on RPC errors; callers wrap in try/catch and convert to
  /// `Result`.
  call: <Returned = unknown>(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
    chainId?: number;
  }) => Promise<{ result: Returned; txHash: Hex }>;
}

// ─── ABIs (minimal — only the functions we call) ────────────────────────

const AGENT_NFT_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'capabilityManifest', type: 'bytes' },
    ],
    outputs: [{ name: 'tokenId', type: 'uint256' }],
  },
] as const;

const AGENT_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentURI', type: 'string' },
      {
        name: 'metadata',
        type: 'tuple[]',
        components: [
          { name: 'metadataKey', type: 'string' },
          { name: 'metadataValue', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
] as const;

const ENS_REGISTRAR_ABI = [
  {
    type: 'function',
    name: 'mintSubname',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'label', type: 'string' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ name: 'node', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'publicMintSubname',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'label', type: 'string' }],
    outputs: [{ name: 'node', type: 'bytes32' }],
  },
] as const;

const SPEND_CAP_ABI = [
  {
    type: 'function',
    name: 'grant',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'asset', type: 'address' },
      { name: 'maxPerPeriod', type: 'uint128' },
      { name: 'periodLength', type: 'uint64' },
      { name: 'expiresAt', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'grantPermission',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'asset', type: 'address' },
      { name: 'permissionId', type: 'bytes32' },
      { name: 'maxPerPeriod', type: 'uint128' },
      { name: 'periodLength', type: 'uint64' },
      { name: 'expiresAt', type: 'uint64' },
    ],
    outputs: [],
  },
] as const;

// ─── Step inputs ────────────────────────────────────────────────────────

export interface MintAgentNFTArgs {
  agentNft: Address;
  owner: Address;
  capabilityManifest: Hex;
  chainId?: number;
}

export interface RegisterAgentArgs {
  agentRegistry: Address;
  agentURI: string;
  metadata: ReadonlyArray<{ metadataKey: string; metadataValue: Hex }>;
  chainId?: number;
}

export interface MintSubnameArgs {
  ensRegistrar: Address;
  label: string;
  owner: Address;
  /// Use `publicMintSubname(label)` when the registrar's public-mint flag
  /// is on. Otherwise call owner-only `mintSubname(label, owner)`.
  publicMint: boolean;
  chainId?: number;
}

export interface GrantSpendCapArgs {
  spendCap: Address;
  account: Address;
  asset: Address;
  /// Max per period in atomic units (e.g. 50_000_000n = 50 USDC at 6 decimals).
  maxPerPeriod: bigint;
  /// Period length in seconds (e.g. 86400n = 1 day).
  periodLength: bigint;
  /// Expiry as unix seconds; 0 = never.
  expiresAt: bigint;
  /// Optional ERC-7715 permission scope. When omitted, falls back to
  /// the legacy default bucket (`bytes32(0)`). Use a content-derived
  /// id (e.g. `keccak256("zhgg.audit.v1")`) to scope this cap to a
  /// single workflow so a high-volume oracle workflow can't drain
  /// caps reserved for low-stakes audits.
  permissionId?: Hex;
  chainId?: number;
}

// ─── Steps ──────────────────────────────────────────────────────────────

export async function mintAgentNFT(
  executor: MintExecutor,
  args: MintAgentNFTArgs
): Promise<Result<{ tokenId: bigint; txHash: Hex }, MintError>> {
  try {
    const { result, txHash } = await executor.call<bigint>({
      address: args.agentNft,
      abi: AGENT_NFT_ABI,
      functionName: 'mint',
      args: [args.owner, args.capabilityManifest],
      chainId: args.chainId,
    });
    return { ok: true, value: { tokenId: result, txHash } };
  } catch (e) {
    return { ok: false, error: { kind: 'mint', reason: errorReason(e) } };
  }
}

export async function registerAgent(
  executor: MintExecutor,
  args: RegisterAgentArgs
): Promise<Result<{ agentId: bigint; txHash: Hex }, MintError>> {
  try {
    const { result, txHash } = await executor.call<bigint>({
      address: args.agentRegistry,
      abi: AGENT_REGISTRY_ABI,
      functionName: 'register',
      args: [args.agentURI, args.metadata],
      chainId: args.chainId,
    });
    return { ok: true, value: { agentId: result, txHash } };
  } catch (e) {
    return { ok: false, error: { kind: 'register', reason: errorReason(e) } };
  }
}

export async function mintSubname(
  executor: MintExecutor,
  args: MintSubnameArgs
): Promise<Result<{ node: Hex; txHash: Hex }, MintError>> {
  try {
    const callArgs = args.publicMint
      ? { functionName: 'publicMintSubname' as const, args: [args.label] as const }
      : { functionName: 'mintSubname' as const, args: [args.label, args.owner] as const };
    const { result, txHash } = await executor.call<Hex>({
      address: args.ensRegistrar,
      abi: ENS_REGISTRAR_ABI,
      functionName: callArgs.functionName,
      args: callArgs.args,
      chainId: args.chainId,
    });
    return { ok: true, value: { node: result, txHash } };
  } catch (e) {
    return { ok: false, error: { kind: 'ens', reason: errorReason(e) } };
  }
}

export async function grantSpendCap(
  executor: MintExecutor,
  args: GrantSpendCapArgs
): Promise<Result<{ txHash: Hex }, MintError>> {
  try {
    // When the caller specifies a permissionId, route through the
    // ERC-7715-aligned `grantPermission` function so the cap is scoped
    // to that workflow. Omitting the field keeps the legacy
    // single-bucket behavior — the contract treats `permissionId == 0`
    // as the default bucket so old `grant` callers don't drift.
    const useScoped = args.permissionId !== undefined;
    const { txHash } = await executor.call<void>({
      address: args.spendCap,
      abi: SPEND_CAP_ABI,
      functionName: useScoped ? 'grantPermission' : 'grant',
      args: useScoped
        ? [
            args.account,
            args.asset,
            args.permissionId!,
            args.maxPerPeriod,
            args.periodLength,
            args.expiresAt,
          ]
        : [
            args.account,
            args.asset,
            args.maxPerPeriod,
            args.periodLength,
            args.expiresAt,
          ],
      chainId: args.chainId,
    });
    return { ok: true, value: { txHash } };
  } catch (e) {
    return { ok: false, error: { kind: 'spend_cap', reason: errorReason(e) } };
  }
}

function errorReason(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
