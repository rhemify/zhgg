/// Shared proof-formatting utilities for the demo CLI.
///
/// Two exports:
///   readFeeSplit  — fetch a Base Sepolia tx receipt and decode the
///                   FeeSplitter.Split event into typed bigints.
///   printTxProof  — consistent wallet/before/tx/after/done block used
///                   by every tx-emitting action (fund-router, mint, etc.)

import {
  createPublicClient,
  http,
  parseAbi,
  parseEventLogs,
  type Hex,
} from 'viem';

const SPLIT_ABI = parseAbi([
  'event Split(address indexed agentOwner, address indexed asset, uint256 totalAmount, uint256 ownerCut, uint256 keeperCut, uint256 zhggCut, uint256 commonsCut, bytes32 attributionTag)',
] as const);

export interface FeeSplitResult {
  txHash: Hex;
  asset: string;
  totalAmount: bigint;
  /// 85% — agent owner / workflow creator
  author: bigint;
  /// 5% — KeeperHub
  kh: bigint;
  /// 5% — zhgg treasury
  zhgg: bigint;
  /// 5% — reputation commons
  commons: bigint;
}

/// Fetch a Base Sepolia settlement tx and decode the FeeSplitter.Split event.
/// Returns null when the tx has no Split log (e.g. dry-run, x402 path, or
/// wrong chain). Never throws — callers degrade gracefully.
export async function readFeeSplit(
  txHash: Hex,
  baseRpcUrl: string
): Promise<FeeSplitResult | null> {
  const pub = createPublicClient({ transport: http(baseRpcUrl) });
  try {
    const receipt = await pub.getTransactionReceipt({ hash: txHash });
    const decoded = parseEventLogs({
      abi: SPLIT_ABI,
      eventName: 'Split',
      logs: receipt.logs,
    });
    const first = decoded[0];
    if (!first || first.eventName !== 'Split') return null;
    const a = first.args;
    return {
      txHash,
      asset: a.asset,
      totalAmount: a.totalAmount,
      author: a.ownerCut,
      kh: a.keeperCut,
      zhgg: a.zhggCut,
      commons: a.commonsCut,
    };
  } catch {
    return null;
  }
}

/// Format a FeeSplitResult as a USDC dollar string, e.g. "$0.0850".
/// Assumes 6-decimal USDC.
export function fmtUsdc(atomic: bigint): string {
  const whole = atomic / 1_000_000n;
  const frac = atomic % 1_000_000n;
  return `$${whole}.${frac.toString().padStart(6, '0')}`;
}

export interface TxProofArgs {
  wallet: string;
  /// Balance before the tx, in human-readable units (e.g. "36.07 OG").
  before: string;
  /// Optional — omit when the SDK doesn't expose the underlying tx hash.
  txHash?: string;
  /// Balance after the tx (e.g. "33.07 OG").
  after: string;
  /// Optional explorer URL for the tx (only printed when txHash is set).
  explorerUrl?: string;
  /// Optional locked/reserved balance to append to `after` (e.g. "3.0 OG").
  locked?: string;
}

/// Print a consistent wallet/before/[tx/]after/done block to stdout.
/// The tx line is omitted when `txHash` is not provided (e.g. broker SDK
/// paths that don't expose the underlying hash).
export function printTxProof(args: TxProofArgs): void {
  const afterLine = args.locked
    ? `${args.after} (locked: ${args.locked})`
    : args.after;
  console.log(`wallet:        ${args.wallet}`);
  console.log(`before:        ${args.before}`);
  if (args.txHash) {
    const txLine = args.explorerUrl
      ? `${args.txHash} · ${args.explorerUrl}`
      : args.txHash;
    console.log(`tx:            ${txLine}`);
  }
  console.log(`after:         ${afterLine}`);
  console.log('✓ done.');
}
