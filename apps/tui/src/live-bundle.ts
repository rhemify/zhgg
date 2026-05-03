// ── Live deps (lazy — only built when first dispatch happens) ────────────────
//
// Single source of truth for all live clients (Base Sepolia + 0G
// Galileo) and contract addresses the dispatchers need. Built once on
// first call to `tryBuildLiveBundle()` and memoised; failures are
// captured into `liveBundleError` so the header pill can show exactly
// which env var is missing.

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildLiveDeps, readLiveConfigFromEnv } from '../../demo/src/live-deps.js';
import type { LiveBundle as DemoLiveBundle } from '../../demo/src/live-deps.js';
import { createReceiptFeed, type ReceiptFeed } from './receipt-feed.js';

export interface LiveBundle {
  basePub: PublicClient;
  baseWallet: WalletClient;
  baseAccount: ReturnType<typeof privateKeyToAccount>;
  feeSplitter: Address;
  spendCap: Address | null;
  usdc: Address;
  oracleOwner: Address;
  receiptFeed: ReceiptFeed;
  /// 0G Galileo (chainId 16602) clients — built once and reused by the
  /// operator UX intents (`agents`, `balances`, `block`, `mint`). Kept on
  /// the bundle so we don't recreate transports per keystroke. The wallet
  /// is bound to MINT_AGENT_PRIVATE_KEY when present (the dedicated EOA
  /// authorized to call AgentNFT.mint), falling back to ZG_PRIVATE_KEY.
  zgPub: PublicClient;
  zgWallet: WalletClient;
  zgAccount: ReturnType<typeof privateKeyToAccount>;
  zgRpcUrl: string;
  /// Address of AgentNFT (ERC-7857) on 0G Galileo. Optional because the
  /// CLI/demo flows don't strictly require it — but `mint` and `agents`
  /// need it; absence is surfaced as a typed err row, not a crash.
  agentNft: Address | null;
  /// Full demo orchestrator deps (real settle, real Qwen call via the
  /// 0G router, real ERC-8004 receipt). Built from the same `buildLiveDeps()`
  /// the CLI uses — single source of truth, zero synthetic divergence.
  demo: DemoLiveBundle;
  /// True when ZG_ROUTER_KEY is non-empty. When false, `demo.deps.auditDeps.infer`
  /// is the synthetic fallback baked into live-deps.ts — the TUI refuses to
  /// dispatch audit intents in that state (per "no fake" rule). Settle/receipt
  /// legs still work because they don't depend on Qwen.
  inferenceReady: boolean;
  /// Deployed AgentReceiverWallet address — the ERC-7710 delegator. Required
  /// for `delegate` intents: the manager's ERC-1271 check calls
  /// `isValidSignature` on this contract (not the raw EOA).
  receiverWallet: Address | null;
}

let liveBundle: LiveBundle | null = null;
let liveBundleError: string | null = null;

export function getLiveBundleError(): string | null {
  return liveBundleError;
}

export function tryBuildLiveBundle(): LiveBundle | null {
  if (liveBundle) return liveBundle;
  if (liveBundleError) return null;
  try {
    // readLiveConfigFromEnv throws on any missing required env var with a
    // named message — we surface that to the header pill so the operator
    // knows EXACTLY which key is missing, not a vague "env error".
    const cfg = readLiveConfigFromEnv();
    const demo = buildLiveDeps(cfg);

    const baseRpc = cfg.baseSepoliaRpc;
    const zgRpc = cfg.zgRpc;
    const account = privateKeyToAccount(cfg.baseSepoliaPrivateKey);
    const baseTransport = http(baseRpc);
    const basePub = createPublicClient({ transport: baseTransport });
    const baseWallet = createWalletClient({ account, transport: baseTransport });
    const receiptFeed = createReceiptFeed({ baseRpcUrl: baseRpc, zgRpcUrl: zgRpc });

    // 0G Galileo clients — separate transport from Base. Mint prefers
    // MINT_AGENT_PRIVATE_KEY (the EOA authorized to call AgentNFT.mint
    // on the deployed contract); falls back to ZG_PRIVATE_KEY when
    // unset. We never echo or log the key.
    const zgTransport = http(zgRpc);
    const zgPub = createPublicClient({ transport: zgTransport });
    const mintKey: Hex = (process.env.MINT_AGENT_PRIVATE_KEY ?? '').length === 66
      ? (process.env.MINT_AGENT_PRIVATE_KEY as Hex)
      : cfg.zgPrivateKey;
    const zgAccount = privateKeyToAccount(mintKey);
    const zgWallet = createWalletClient({ account: zgAccount, transport: zgTransport });
    const agentNftEnv = process.env.AGENT_NFT_ADDRESS;
    const agentNft: Address | null =
      agentNftEnv && /^0x[a-fA-F0-9]{40}$/.test(agentNftEnv)
        ? (agentNftEnv as Address)
        : null;
    const receiverWalletEnv = process.env.AGENT_RECEIVER_WALLET_ADDRESS;
    const receiverWallet: Address | null =
      receiverWalletEnv && /^0x[a-fA-F0-9]{40}$/.test(receiverWalletEnv)
        ? (receiverWalletEnv as Address)
        : null;

    liveBundle = {
      basePub,
      baseWallet,
      baseAccount: account,
      feeSplitter: cfg.feeSplitter,
      spendCap: cfg.spendCap ?? null,
      usdc: cfg.usdc,
      oracleOwner: cfg.oracleOwner,
      receiptFeed,
      zgPub,
      zgWallet,
      zgAccount,
      zgRpcUrl: zgRpc,
      agentNft,
      demo,
      inferenceReady: cfg.zgRouterKey !== undefined && cfg.zgRouterKey.length > 0,
      receiverWallet,
    };
    return liveBundle;
  } catch (e) {
    liveBundleError = e instanceof Error ? e.message : String(e);
    return null;
  }
}
