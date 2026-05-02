/// Across V3 SpokePool client — Phase 20.
///
/// Wraps `depositV3` on the origin SpokePool + waits for the destination
/// `FilledV3Relay` event. Real RPC, no stubs. Targets the production
/// Base Sepolia + Arbitrum Sepolia testnet contracts; mainnet addresses
/// are provided alongside but require a real funded wallet to exercise.
///
/// Reference: https://docs.across.to/concepts/intents-architecture-in-across
///
/// Trust model: relayers front liquidity in 1-3 seconds; the
/// `FilledV3Relay` event on the destination chain is the user's
/// terminal signal. The HubPool's optimistic-oracle dispute window
/// (~1h) is a relayer-side risk, NOT a user-side risk.

import {
  decodeEventLog,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';

/// CAIP-2 chain id → Across SpokePool address. Static for v3.
/// Source: https://docs.across.to/reference/contract-addresses
export const SPOKE_POOL: Record<string, Address> = {
  // Mainnet
  'eip155:1':       '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5', // Ethereum
  'eip155:8453':    '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64', // Base
  'eip155:42161':   '0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A', // Arbitrum
  'eip155:10':      '0x6f26Bf09B1C792e3228e5467807a900A503c0281', // Optimism
  // Testnet
  'eip155:84532':   '0x82B564983aE7274c86695917BBf8C99ECb6F0F8F', // Base Sepolia
  'eip155:421614':  '0xC8c305b1E6Ad21CCe19Ee0Cf95E37Ce18b3a45fc', // Arbitrum Sepolia
  'eip155:11155111':'0x14224e63716afAcE30C9a417E0542281869f7d9e', // Sepolia (HubPool)
};

/// Look up the SpokePool for a CAIP-2 chain. Returns null when
/// unsupported so callers fail-loud instead of routing into the void.
export function spokePoolFor(chain: string): Address | null {
  return SPOKE_POOL[chain] ?? null;
}

/// Subset of the V3 SpokePool ABI we use. Keeping it inline avoids
/// pulling in @across-protocol/contracts (heavy + ethers-bound).
export const SPOKE_POOL_ABI = parseAbi([
  'function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message) payable',
  'event V3FundsDeposited(address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint32 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, address indexed depositor, address recipient, address exclusiveRelayer, bytes message)',
  'event FilledV3Relay(address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 repaymentChainId, uint256 indexed originChainId, uint32 indexed depositId, uint32 fillDeadline, uint32 exclusivityDeadline, address exclusiveRelayer, address indexed relayer, address depositor, address recipient, bytes message)',
]);

export interface BridgeArgs {
  /// CAIP-2 origin (e.g. "eip155:42161" for Arbitrum Sepolia).
  fromChain: string;
  /// CAIP-2 destination (e.g. "eip155:84532" for Base Sepolia).
  toChain: string;
  inputToken: Address;
  outputToken: Address;
  /// Amount on origin (the user pays this).
  inputAmount: bigint;
  /// Amount delivered on destination after relayer fee. Caller is
  /// responsible for fetching a quote first; defaults match
  /// Across's documented ~0.1% spread.
  outputAmount: bigint;
  /// Final recipient on destination chain (typically the
  /// AgentReceiverWallet of the receiving agent).
  recipient: Address;
  /// Depositor (must equal `walletClient.account.address`).
  depositor: Address;
  /// Relayer-exclusivity window in seconds. 0 = open auction. Larger
  /// values give a specific relayer first-fill rights — useful for
  /// committed RFQ flows.
  exclusivityDeadlineSeconds?: number;
  /// Per-deposit fill deadline (seconds). Default 1 hour.
  fillDeadlineSeconds?: number;
  /// Across quote timestamp — usually `block.timestamp` when sending.
  /// Caller passes it explicitly to keep the function deterministic.
  quoteTimestamp: number;
  /// Optional message for receiver-side hooks. Use `0x` for plain
  /// USDC transfer — no receiver hook fired.
  message?: Hex;
}

export interface BridgeResult {
  depositTxHash: Hex;
  /// `depositId` parsed from the V3FundsDeposited event. Used to
  /// match the destination FilledV3Relay later.
  depositId: number;
}

export type BridgeError =
  | { kind: 'unsupported_chain'; chain: string }
  | { kind: 'submit_failed'; reason: string }
  | { kind: 'event_not_found' };

export type BridgeOutcome = { ok: true; value: BridgeResult } | { ok: false; error: BridgeError };

/// Initiate an Across V3 deposit. Caller must ensure `inputToken` is
/// approved for `walletClient.account.address` → `spokePool` for
/// `inputAmount`. Returns the depositId so callers can wait for the
/// fill on the destination chain.
export async function bridgeViaAcross(
  args: BridgeArgs,
  walletClient: WalletClient,
  publicClient: PublicClient
): Promise<BridgeOutcome> {
  const spokePool = spokePoolFor(args.fromChain);
  if (!spokePool) {
    return { ok: false, error: { kind: 'unsupported_chain', chain: args.fromChain } };
  }
  const account = walletClient.account;
  if (!account) {
    return { ok: false, error: { kind: 'submit_failed', reason: 'no account on wallet' } };
  }

  const destChainId = caip2ToChainId(args.toChain);
  if (destChainId === null) {
    return { ok: false, error: { kind: 'unsupported_chain', chain: args.toChain } };
  }

  const fillDeadline = args.quoteTimestamp + (args.fillDeadlineSeconds ?? 3600);
  const exclusivityDeadline = args.exclusivityDeadlineSeconds
    ? args.quoteTimestamp + args.exclusivityDeadlineSeconds
    : 0;

  let txHash: Hex;
  try {
    const sim = await publicClient.simulateContract({
      account,
      address: spokePool,
      abi: SPOKE_POOL_ABI,
      functionName: 'depositV3',
      args: [
        args.depositor,
        args.recipient,
        args.inputToken,
        args.outputToken,
        args.inputAmount,
        args.outputAmount,
        BigInt(destChainId),
        '0x0000000000000000000000000000000000000000' as Address, // exclusiveRelayer = 0 (open)
        args.quoteTimestamp,
        fillDeadline,
        exclusivityDeadline,
        args.message ?? '0x',
      ],
    });
    txHash = await walletClient.writeContract(sim.request);
  } catch (e) {
    return {
      ok: false,
      error: { kind: 'submit_failed', reason: e instanceof Error ? e.message : String(e) },
    };
  }

  // Wait for the receipt + extract depositId from V3FundsDeposited.
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  let depositId: number | null = null;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: SPOKE_POOL_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'V3FundsDeposited') {
        depositId = Number(decoded.args.depositId);
        break;
      }
    } catch {
      // Not the event we want — skip.
    }
  }
  if (depositId === null) {
    return { ok: false, error: { kind: 'event_not_found' } };
  }

  return { ok: true, value: { depositTxHash: txHash, depositId } };
}

/// Convert CAIP-2 → numeric chain ID. Returns null for malformed input.
export function caip2ToChainId(caip2: string): number | null {
  const match = caip2.match(/^eip155:(\d+)$/);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10);
}

export interface WaitForFillArgs {
  /// Destination chain client (must be on `toChain`).
  destPublicClient: PublicClient;
  /// CAIP-2 origin chain — used to derive originChainId for the event filter.
  fromChain: string;
  /// CAIP-2 destination chain.
  toChain: string;
  /// `depositId` from the origin's V3FundsDeposited event.
  depositId: number;
  /// Polling interval (ms). Default 2000.
  pollIntervalMs?: number;
  /// Max time to wait (ms). Default 60000 (1 minute — far longer than
  /// the typical 1-3s relayer fill).
  timeoutMs?: number;
}

export type WaitForFillError =
  | { kind: 'unsupported_chain'; chain: string }
  | { kind: 'timeout'; depositId: number; elapsedMs: number };

export type WaitForFillOutcome =
  | { ok: true; value: { fillTxHash: Hex; relayer: Address } }
  | { ok: false; error: WaitForFillError };

/// Poll the destination SpokePool for the matching FilledV3Relay event.
/// Returns when the relayer fills the deposit (typically 1-3s on
/// mainnet, longer on quiet testnets).
export async function waitForFill(args: WaitForFillArgs): Promise<WaitForFillOutcome> {
  const destSpoke = spokePoolFor(args.toChain);
  if (!destSpoke) {
    return { ok: false, error: { kind: 'unsupported_chain', chain: args.toChain } };
  }
  const originChainId = caip2ToChainId(args.fromChain);
  if (originChainId === null) {
    return { ok: false, error: { kind: 'unsupported_chain', chain: args.fromChain } };
  }

  const pollMs = args.pollIntervalMs ?? 2000;
  const timeoutMs = args.timeoutMs ?? 60_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const logs = await args.destPublicClient.getLogs({
      address: destSpoke,
      event: SPOKE_POOL_ABI[2], // FilledV3Relay
      args: { originChainId: BigInt(originChainId), depositId: args.depositId },
      fromBlock: 'earliest',
      toBlock: 'latest',
    });
    if (logs.length > 0) {
      const log = logs[0]!;
      // Decode args manually since `relayer` is in the indexed-topics path
      const relayer = (log.args.relayer ?? '0x0000000000000000000000000000000000000000') as Address;
      return { ok: true, value: { fillTxHash: log.transactionHash!, relayer } };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  return {
    ok: false,
    error: { kind: 'timeout', depositId: args.depositId, elapsedMs: Date.now() - start },
  };
}
