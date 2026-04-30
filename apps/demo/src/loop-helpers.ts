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

import { keccak256, parseAbi, toHex, type Address, type Hex } from 'viem';

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient: any;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  walletClient: any;
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
    const receipt = await args.publicClient.waitForTransactionReceipt({ hash: txHash });
    // Derive commitId locally — keccak256(abi.encodePacked(uint256, bytes32, address, uint256)).
    // Using the simulated `result` is unreliable across viem versions; the
    // local derivation is what off-chain indexers use anyway.
    const blockNumber = BigInt(receipt.blockNumber ?? 0);
    const commitId = computeCommitId(
      args.tokenId,
      planHash,
      args.walletClient.account.address as Address,
      blockNumber
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  walletClient: any;
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
    await args.publicClient.waitForTransactionReceipt({ hash: txHash });
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  walletClient: any;
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
    await args.publicClient.waitForTransactionReceipt({ hash: txHash });
    return { ok: true, value: { txHash } };
  } catch (e) {
    return { ok: false, error: { kind: 'pin_failed', reason: errMsg(e) } };
  }
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

function computeCommitId(
  tokenId: bigint,
  planHash: Hex,
  sender: Address,
  blockNumber: bigint
): Hex {
  // keccak256(abi.encodePacked(uint256, bytes32, address, uint256))
  const tid = tokenId.toString(16).padStart(64, '0');
  const ph = planHash.slice(2);
  const addr = sender.slice(2).toLowerCase();
  const bn = blockNumber.toString(16).padStart(64, '0');
  return keccak256(`0x${tid}${ph}${addr}${bn}` as Hex);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
