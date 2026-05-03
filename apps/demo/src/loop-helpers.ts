/// Always-active loop helpers — Steps 1, 3, 9, 10 of the zhgg audit loop.
///
/// Step 1: read iNFT capabilities manifest before any external call.
/// Step 3: AXIOM commit (keccak256 of canonical plan) — pre-commits the
///         agent's intended action so an oracle response can't substitute
///         the plan after the fact.
/// Step 9: pin the storage rootHash of the audit log to iNFT.memoryRoot.
/// Step 10: AXIOM reveal — publish the plan + result tuple after Step 8
///         lands the audit log on 0G Storage.
///
/// All four helpers fail-open when their address is null so mock-mode
/// demos run untouched. Errors are returned as `Result<T, E>` to mirror
/// the pattern in `packages/workflow/src/storage-log.ts`.

import {
  encodePacked,
  getAddress,
  keccak256,
  parseAbi,
  toHex,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/// viem client aliases — write-side helpers in this module need a
/// wallet client with a resolved account (so `simulateContract` can
/// pass `account` through and the orchestrator can derive `commitId`
/// from `walletClient.account.address`). Read-side helpers only need
/// the public client; we keep the chain generic open so the same
/// helper works against Galileo, Base Sepolia, or any other EVM chain.
type LoopPublicClient = PublicClient<Transport, Chain | undefined>;
type LoopWalletClient = WalletClient<Transport, Chain | undefined, Account>;

const AGENT_NFT_LOOP_ABI = parseAbi([
  'function capabilities(uint256 tokenId) view returns (bytes)',
  'function updateMemoryRoot(uint256 tokenId, bytes32 storageRoot)',
]);

const AXIOM_COMMIT_ABI = parseAbi([
  'function commitPlan(uint256 tokenId, bytes32 planHash) returns (bytes32 commitId)',
  'function revealPlan(uint256 tokenId, bytes32 commitId, bytes plan, bytes result)',
]);

// ---------------------------------------------------------------------
// Step 1 — read iNFT capability manifest
// ---------------------------------------------------------------------

export type CapabilitiesError =
  | { kind: 'not_configured' }
  | { kind: 'read_failed'; reason: string };

export interface ReadCapabilitiesArgs {
  agentNftAddress: Address | null;
  tokenId: bigint;
  publicClient: LoopPublicClient;
}

export async function readAgentCapabilities(
  args: ReadCapabilitiesArgs
): Promise<Result<Hex, CapabilitiesError>> {
  if (!args.agentNftAddress) return { ok: false, error: { kind: 'not_configured' } };
  try {
    const bytes = (await args.publicClient.readContract({
      address: args.agentNftAddress,
      abi: AGENT_NFT_LOOP_ABI,
      functionName: 'capabilities',
      args: [args.tokenId],
    })) as Hex;
    return { ok: true, value: bytes };
  } catch (e) {
    return { ok: false, error: { kind: 'read_failed', reason: errMsg(e) } };
  }
}

// ---------------------------------------------------------------------
// Step 3 — AXIOM commit
// ---------------------------------------------------------------------

export type AxiomError =
  | { kind: 'not_configured' }
  | { kind: 'commit_failed'; reason: string }
  | { kind: 'reveal_failed'; reason: string };

export interface AxiomCommitArgs {
  axiomAddress: Address | null;
  tokenId: bigint;
  /// Raw plan bytes — typically the canonical JSON of the intent the
  /// agent has decided to execute. Hashed locally; the chain only sees
  /// the hash until reveal.
  plan: Uint8Array | Hex;
  publicClient: LoopPublicClient;
  walletClient: LoopWalletClient;
}

export interface AxiomCommitResult {
  commitId: Hex;
  txHash: Hex;
  planHash: Hex;
}

export async function commitPlan(
  args: AxiomCommitArgs
): Promise<Result<AxiomCommitResult, AxiomError>> {
  if (!args.axiomAddress) return { ok: false, error: { kind: 'not_configured' } };
  const planBytes = typeof args.plan === 'string' ? args.plan : toHex(args.plan);
  const planHash = keccak256(planBytes);
  try {
    const sim = await args.publicClient.simulateContract({
      account: args.walletClient.account,
      address: args.axiomAddress,
      abi: AXIOM_COMMIT_ABI,
      functionName: 'commitPlan',
      args: [args.tokenId, planHash],
    });
    const txHash = (await args.walletClient.writeContract(sim.request)) as Hex;
    // Wait for confirmation and use receipt.blockNumber — the contract stores
    // block.number at mine time, so computing commitId from a pre-submission
    // snapshot produces a wrong hash and causes reveal to fail with CommitNotFound.
    //
    // 0G Galileo's RPC sometimes returns receipts with blockTimestamp: "0x0"
    // which causes viem's waitForTransactionReceipt to reject them. We poll
    // getTransactionReceipt directly instead.
    const receipt = await pollReceipt(args.publicClient, txHash, 150_000, 2_000);
    const commitId = computeCommitId(
      args.tokenId,
      planHash,
      args.walletClient.account.address as Address,
      receipt.blockNumber,
    );
    return { ok: true, value: { commitId, txHash, planHash } };
  } catch (e) {
    return { ok: false, error: { kind: 'commit_failed', reason: errMsg(e) } };
  }
}

// ---------------------------------------------------------------------
// Step 10 — AXIOM reveal
// ---------------------------------------------------------------------

export interface AxiomRevealArgs {
  axiomAddress: Address | null;
  tokenId: bigint;
  commitId: Hex;
  plan: Uint8Array | Hex;
  result: Uint8Array | Hex;
  publicClient: LoopPublicClient;
  walletClient: LoopWalletClient;
}

export async function revealPlan(
  args: AxiomRevealArgs
): Promise<Result<{ txHash: Hex }, AxiomError>> {
  if (!args.axiomAddress) return { ok: false, error: { kind: 'not_configured' } };
  const planHex = typeof args.plan === 'string' ? args.plan : toHex(args.plan);
  const resultHex = typeof args.result === 'string' ? args.result : toHex(args.result);
  try {
    const sim = await args.publicClient.simulateContract({
      account: args.walletClient.account,
      address: args.axiomAddress,
      abi: AXIOM_COMMIT_ABI,
      functionName: 'revealPlan',
      args: [args.tokenId, args.commitId, planHex, resultHex],
    });
    const txHash = (await args.walletClient.writeContract(sim.request)) as Hex;
    args.publicClient
      .waitForTransactionReceipt({ hash: txHash, timeout: 300_000, pollingInterval: 2_000 })
      .catch(() => { /* non-fatal */ });
    return { ok: true, value: { txHash } };
  } catch (e) {
    return { ok: false, error: { kind: 'reveal_failed', reason: errMsg(e) } };
  }
}

// ---------------------------------------------------------------------
// Step 9 — pin memory root on iNFT
// ---------------------------------------------------------------------

export type MemoryRootError =
  | { kind: 'not_configured' }
  | { kind: 'pin_failed'; reason: string };

export interface PinMemoryRootArgs {
  agentNftAddress: Address | null;
  tokenId: bigint;
  rootHash: Hex;
  publicClient: LoopPublicClient;
  walletClient: LoopWalletClient;
}

export async function pinMemoryRoot(
  args: PinMemoryRootArgs
): Promise<Result<{ txHash: Hex }, MemoryRootError>> {
  if (!args.agentNftAddress) return { ok: false, error: { kind: 'not_configured' } };
  try {
    const sim = await args.publicClient.simulateContract({
      account: args.walletClient.account,
      address: args.agentNftAddress,
      abi: AGENT_NFT_LOOP_ABI,
      functionName: 'updateMemoryRoot',
      args: [args.tokenId, args.rootHash],
    });
    const txHash = (await args.walletClient.writeContract(sim.request)) as Hex;
    args.publicClient
      .waitForTransactionReceipt({ hash: txHash, timeout: 300_000, pollingInterval: 2_000 })
      .catch(() => { /* non-fatal */ });
    return { ok: true, value: { txHash } };
  } catch (e) {
    return { ok: false, error: { kind: 'pin_failed', reason: errMsg(e) } };
  }
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

/// Mirror of `AxiomCommit.commitPlan`'s on-chain commitId derivation:
/// `keccak256(abi.encodePacked(uint256 tokenId, bytes32 planHash, address sender, uint256 blockNumber))`.
/// `getAddress` canonicalizes the input to a checksum-checked 20-byte
/// hex string so non-canonical inputs (lowercase, padded, etc.) all
/// hash to the same value as the on-chain encoding.
export function computeCommitId(
  tokenId: bigint,
  planHash: Hex,
  sender: Address,
  blockNumber: bigint
): Hex {
  return keccak256(
    encodePacked(
      ['uint256', 'bytes32', 'address', 'uint256'],
      [tokenId, planHash, getAddress(sender), blockNumber]
    )
  );
}

/// Poll `eth_getTransactionReceipt` directly, bypassing viem's
/// `waitForTransactionReceipt` which rejects receipts with
/// `blockTimestamp: "0x0"` (a quirk of 0G Galileo's RPC).
async function pollReceipt(
  client: LoopPublicClient,
  hash: Hex,
  timeoutMs: number,
  intervalMs: number,
): Promise<{ blockNumber: bigint; status: 'success' | 'reverted' }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await client.getTransactionReceipt({ hash });
      if (r) {
        if (r.status === 'reverted') throw new Error('transaction reverted');
        return { blockNumber: r.blockNumber, status: r.status };
      }
    } catch (e) {
      // getTransactionReceipt throws when not yet found — keep polling
      if (e instanceof Error && e.message === 'transaction reverted') throw e;
    }
    await new Promise(res => setTimeout(res, intervalMs));
  }
  throw new Error(`receipt for ${hash} not found within ${timeoutMs}ms`);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
