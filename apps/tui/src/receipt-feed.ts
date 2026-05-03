/// Pulls real on-chain logs for a settled tx and decodes them into the
/// JSON the RECEIPT panel renders.
///
/// We only decode events from contracts the demo orchestrator actually
/// writes against during the audit↔oracle loop:
///   - FeeSplitter.Split        (Base Sepolia, x402 settlement)
///   - AgentRegistry.NewFeedback (0G Galileo, ERC-8004 receipt post)
///
/// Anti-slop policy: every field returned here must come off-chain. We
/// NEVER fabricate `rail`, `splits.bps`, etc. — the panel only renders
/// what `parseEventLogs` decoded. When no settlement has happened yet,
/// the caller renders the empty placeholder instead.

import {
  createPublicClient,
  http,
  parseAbi,
  parseEventLogs,
  type Hex,
  type PublicClient,
} from 'viem';

/// Verbatim event signatures from the Solidity sources. Using
/// `parseAbi` with the literal array (not parseAbiItem-then-cast)
/// preserves viem's tuple-literal inference, which is what gives
/// the decoded `args` strong fields like `agentOwner`, `ownerCut`,
/// etc. — `Abi` (the wide type) drops them to `never`.
///
/// FeeSplitter.sol:
///   event Split(address indexed agentOwner, address indexed asset,
///               uint256 totalAmount, uint256 ownerCut, uint256 keeperCut,
///               uint256 zhggCut, uint256 commonsCut, bytes32 attributionTag);
///
/// AgentRegistry.sol:
///   event NewFeedback(uint256 indexed agentId, address indexed clientAddress,
///                     uint64 feedbackIndex, int128 value, uint8 valueDecimals,
///                     string indexed indexedTag1, string tag1, string tag2,
///                     string endpoint, string feedbackURI, bytes32 feedbackHash);
const RECEIPT_ABI = parseAbi([
  'event Split(address indexed agentOwner, address indexed asset, uint256 totalAmount, uint256 ownerCut, uint256 keeperCut, uint256 zhggCut, uint256 commonsCut, bytes32 attributionTag)',
  'event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
] as const);

export interface ReceiptFeedConfig {
  /// Base Sepolia RPC for FeeSplitter.Split logs.
  baseRpcUrl: string;
  /// 0G Galileo RPC for AgentRegistry.NewFeedback logs.
  zgRpcUrl: string;
}

export interface DecodedSplit {
  event: 'Split';
  txHash: Hex;
  blockNumber: string;
  network: string;
  agentOwner: string;
  asset: string;
  totalAmount: string;
  ownerCut: string;
  keeperCut: string;
  zhggCut: string;
  commonsCut: string;
  attributionTag: Hex;
}

export interface DecodedNewFeedback {
  event: 'NewFeedback';
  txHash: Hex;
  blockNumber: string;
  network: string;
  agentId: string;
  clientAddress: string;
  feedbackIndex: string;
  value: string;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: Hex;
}

export type DecodedReceipt = DecodedSplit | DecodedNewFeedback;

export interface ReceiptFeed {
  /// Fetch the receipt for a Base Sepolia settlement tx and decode the
  /// `FeeSplitter.Split` event. Returns `null` (not throws) when the tx
  /// has no logs we recognise — the panel renders the placeholder.
  fetchSplit(txHash: Hex): Promise<DecodedSplit | null>;
  /// Same shape for `AgentRegistry.NewFeedback` on 0G Galileo.
  fetchNewFeedback(txHash: Hex): Promise<DecodedNewFeedback | null>;
}

export function createReceiptFeed(cfg: ReceiptFeedConfig): ReceiptFeed {
  const basePub: PublicClient = createPublicClient({ transport: http(cfg.baseRpcUrl) });
  const zgPub: PublicClient = createPublicClient({ transport: http(cfg.zgRpcUrl) });

  return {
    async fetchSplit(txHash) {
      const receipt = await basePub.getTransactionReceipt({ hash: txHash });
      const decoded = parseEventLogs({
        abi: RECEIPT_ABI,
        eventName: 'Split',
        logs: receipt.logs,
      });
      const first = decoded[0];
      if (!first || first.eventName !== 'Split') return null;
      const a = first.args;
      return {
        event: 'Split',
        txHash,
        blockNumber: receipt.blockNumber.toString(),
        network: 'eip155:84532',
        agentOwner: a.agentOwner,
        asset: a.asset,
        totalAmount: a.totalAmount.toString(),
        ownerCut: a.ownerCut.toString(),
        keeperCut: a.keeperCut.toString(),
        zhggCut: a.zhggCut.toString(),
        commonsCut: a.commonsCut.toString(),
        attributionTag: a.attributionTag,
      };
    },

    async fetchNewFeedback(txHash) {
      const receipt = await zgPub.getTransactionReceipt({ hash: txHash });
      const decoded = parseEventLogs({
        abi: RECEIPT_ABI,
        eventName: 'NewFeedback',
        logs: receipt.logs,
      });
      const first = decoded[0];
      if (!first || first.eventName !== 'NewFeedback') return null;
      const a = first.args;
      return {
        event: 'NewFeedback',
        txHash,
        blockNumber: receipt.blockNumber.toString(),
        network: 'eip155:16602',
        agentId: a.agentId.toString(),
        clientAddress: a.clientAddress,
        feedbackIndex: a.feedbackIndex.toString(),
        value: a.value.toString(),
        valueDecimals: a.valueDecimals,
        // `indexedTag1` is the raw indexed-string topic hash; the
        // body's `tag1` is the actual string. Surface only the
        // semantic fields — the topic hash adds noise.
        tag1: a.tag1,
        tag2: a.tag2,
        endpoint: a.endpoint,
        feedbackURI: a.feedbackURI,
        feedbackHash: a.feedbackHash,
      };
    },
  };
}

/// JSON envelope the RECEIPT panel renders. Holds zero, one, or both
/// decoded events depending on which legs of the cross-agent loop have
/// completed. `status` is the only synthetic field — every other key
/// comes off-chain.
export interface ReceiptEnvelope {
  status: 'no settlement yet' | 'settled' | 'settled+receipt';
  split?: DecodedSplit;
  newFeedback?: DecodedNewFeedback;
  /// Raw JSON body returned by a KeeperHub marketplace `kh hire` call.
  /// Only present when the settlement was via the x402/KH path.
  khResponse?: unknown;
}

export const EMPTY_RECEIPT: ReceiptEnvelope = { status: 'no settlement yet' };

export function envelopeJson(env: ReceiptEnvelope): string {
  return JSON.stringify(env, null, 2);
}
