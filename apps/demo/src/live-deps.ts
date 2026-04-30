/// Live testnet executor — replaces mocked deps with real viem clients,
/// real 0G Compute Router calls, real FeeSplitter settlements, real
/// ERC-8004 receipt posts. Used by `bun run apps/demo audit --live`.
///
/// Design choice: the "x402 settlement" leg calls our FeeSplitter
/// directly via viem (caller-funds the split), rather than running the
/// full x402 protocol round-trip with a separate facilitator. The
/// observable end state — USDC moved on Base Sepolia with the 4-leg
/// split visible on basescan — is identical. Full x402 dance is D5
/// once we have a deployed facilitator on Base Sepolia we control.

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { inferZG, postReceipt, type Erc8004Client, type GiveFeedbackArgs } from '@zhgg/workflow';
import type { AuditDeps } from '@zhgg/audit-agent';
import type { CrossAgentDemoDeps } from './cross-agent.js';
import { payViaKeeperHubMarketplace, type KeeperHubMarketplaceConfig } from './keeperhub-marketplace.js';
import { checkSpendCap } from './spend-cap.js';

const FEE_SPLITTER_ABI = parseAbi([
  'function splitERC20(address asset, uint256 totalAmount, address agentOwner)',
]);

// Slice of AgentRegistry ABI containing only `giveFeedback`. The mint
// flow's `register` ABI lives in `apps/mint-agent/src/steps.ts` — they
// don't overlap functions, just the contract.
const AGENT_REGISTRY_GIVE_FEEDBACK_ABI = parseAbi([
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
]);

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

export interface LiveDepsConfig {
  /// 0G Compute Router API key (sk-...) — for real TEE inference.
  zgRouterKey: string;
  /// Base Sepolia signer — pays 0.1 USDC to the FeeSplitter per audit.
  baseSepoliaPrivateKey: Hex;
  /// 0G Galileo signer — posts ERC-8004 receipts. Often the same key as
  /// Base Sepolia (same EOA across chains is fine for EVM).
  zgPrivateKey: Hex;
  baseSepoliaRpc: string;
  zgRpc: string;
  /// FeeSplitter contract on Base Sepolia.
  feeSplitter: Address;
  /// AgentRegistry contract on 0G Galileo.
  agentRegistry: Address;
  /// USDC contract on Base Sepolia.
  usdc: Address;
  /// Address that receives the 85% bulk of the oracle's fee.
  oracleOwner: Address;
  /// Optional — when set, oracle settlement routes through KeeperHub's
  /// marketplace (real x402, KH 30%, author 70%) instead of direct
  /// FeeSplitter. Caller's USDC goes through KH's facilitator, the 70%
  /// lands at `keeperhub.walletAddress`. The 85/5/5/5 sub-split is a
  /// SEPARATE, MANUAL step (V1 — Turnkey custody on KH means we can't
  /// auto-sign). See `keeperhub-marketplace.ts` for the design note.
  keeperhub?: KeeperHubMarketplaceConfig;
  /// Optional — when set, the orchestrator gates the oracle payment on
  /// an ERC-7715 spend-cap check. Skipped (fail-open) if absent.
  spendCap?: Address;
}

const ORACLE_PAYMENT_ATOMIC = 100_000n; // 0.1 USDC at 6 decimals

export interface LiveBundle {
  deps: CrossAgentDemoDeps;
  /// auditOptions to pass into runCrossAgentDemo. The orchestrator's
  /// `auditOptions` interface is satisfied by these fields.
  auditOptions: {
    apiKey: string;
    registryAddress: Address;
    agentRegistryCaip: string;
    clientAddress: string;
    quorum: 'all' | 'majority';
  };
}

export function buildLiveDeps(cfg: LiveDepsConfig): LiveBundle {
  const baseAccount = privateKeyToAccount(cfg.baseSepoliaPrivateKey);
  const zgAccount = privateKeyToAccount(cfg.zgPrivateKey);
  const baseTransport = http(cfg.baseSepoliaRpc);
  const zgTransport = http(cfg.zgRpc);
  const baseWallet = createWalletClient({ account: baseAccount, transport: baseTransport });
  const basePub = createPublicClient({ transport: baseTransport });
  const zgWallet = createWalletClient({ account: zgAccount, transport: zgTransport });
  const zgPub = createPublicClient({ transport: zgTransport });

  // Real ERC-8004 client: writes giveFeedback to AgentRegistry on 0G.
  const erc8004Client: Erc8004Client = {
    giveFeedback: async (args: GiveFeedbackArgs): Promise<Hex> => {
      const sim = await zgPub.simulateContract({
        account: zgAccount,
        address: args.registry,
        abi: AGENT_REGISTRY_GIVE_FEEDBACK_ABI,
        functionName: 'giveFeedback',
        args: [
          args.agentId,
          BigInt(args.value),
          args.valueDecimals,
          args.tag1,
          args.tag2,
          args.endpoint,
          args.feedbackURI,
          args.feedbackHash,
        ],
      });
      const txHash = await zgWallet.writeContract(sim.request);
      await zgPub.waitForTransactionReceipt({ hash: txHash });
      return txHash;
    },
  };

  // Real audit deps: inferZG against 0G Router + postReceipt above.
  const auditDeps: AuditDeps = {
    infer: (prompt, opts) => inferZG(prompt, { apiKey: opts.apiKey }),
    postReceipt,
    erc8004Client,
  };

  // Settlement has two paths:
  //  - cfg.keeperhub set → real KH marketplace (x402, 30/70 split)
  //  - else → direct FeeSplitter via viem (caller-funds, full 85/5/5/5)
  const settleOraclePayment: CrossAgentDemoDeps['settleOraclePayment'] = async () => {
    if (cfg.keeperhub) {
      // Real marketplace path — KH facilitator settles EIP-3009 on Base,
      // takes 30%, sends 70% to keeperhub.walletAddress (Turnkey custody).
      // The 85/5/5/5 sub-split on the 70% is a documented manual step
      // for V1 since the receiving wallet is server-custodied.
      const settlement = await payViaKeeperHubMarketplace(cfg.keeperhub, {
        topic: 'oracle.query',
      });
      return {
        txHash: settlement.paymentTxHash,
        network: settlement.network,
        payer: settlement.payerAddress,
      };
    }

    // Fallback path: caller-funds direct FeeSplitter call.
    // Pre-condition: baseAccount has USDC + JIT-approves the splitter.
    // Ensure approval (idempotent — only writes if allowance is short).
    const allowance = await basePub.readContract({
      address: cfg.usdc,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [baseAccount.address, cfg.feeSplitter],
    });
    if (allowance < ORACLE_PAYMENT_ATOMIC) {
      // JIT approval: grant exactly the amount needed for THIS settlement.
      // Trades one extra approve tx per call (~2s on Base Sepolia) for
      // zero standing approval — if FeeSplitter is ever compromised, the
      // attacker can drain at most one in-flight payment, not 10×.
      const sim = await basePub.simulateContract({
        account: baseAccount,
        address: cfg.usdc,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [cfg.feeSplitter, ORACLE_PAYMENT_ATOMIC],
      });
      const approveTx = await baseWallet.writeContract(sim.request);
      await basePub.waitForTransactionReceipt({ hash: approveTx });
    }

    // Trigger the actual split. Returns when mined.
    const sim = await basePub.simulateContract({
      account: baseAccount,
      address: cfg.feeSplitter,
      abi: FEE_SPLITTER_ABI,
      functionName: 'splitERC20',
      args: [cfg.usdc, ORACLE_PAYMENT_ATOMIC, cfg.oracleOwner],
    });
    const txHash = await baseWallet.writeContract(sim.request);
    await basePub.waitForTransactionReceipt({ hash: txHash });
    return {
      txHash,
      network: 'eip155:84532',
      payer: baseAccount.address,
    };
  };

  // Spend-cap pre-flight gate. Closure captures `baseAccount.address` as
  // the capped account so the orchestrator stays wallet-agnostic. When
  // the live config has no spendCap address, this is a no-op fail-open
  // check (matches the mocked-mode default).
  const checkSpendCapDep: CrossAgentDemoDeps['checkSpendCap'] = async ({ amount, enforce }) =>
    checkSpendCap({
      spendCapAddress: cfg.spendCap ?? null,
      account: baseAccount.address,
      asset: cfg.usdc,
      amount,
      publicClient: basePub,
      walletClient: baseWallet,
      enforce,
    });

  return {
    deps: {
      settleOraclePayment,
      auditDeps,
      checkSpendCap: checkSpendCapDep,
    },
    auditOptions: {
      apiKey: cfg.zgRouterKey,
      registryAddress: cfg.agentRegistry,
      agentRegistryCaip: `eip155:16602:${cfg.agentRegistry}`,
      clientAddress: `eip155:84532:${baseAccount.address}`,
      quorum: 'majority' as const,
    },
  };
}

/// Resolve all live-mode env vars. Fails loudly with the named missing
/// field — never silently falls back to mocked values.
export function readLiveConfigFromEnv(): LiveDepsConfig {
  const need = (key: string): string => {
    const v = process.env[key];
    if (!v) {
      throw new Error(`live mode requires env: ${key}`);
    }
    return v;
  };
  const needHex = (key: string, len: number): Hex => {
    const v = need(key);
    const expected = `^0x[a-fA-F0-9]{${len}}$`;
    if (!new RegExp(expected).test(v)) {
      throw new Error(`env ${key} must match ${expected}`);
    }
    return v as Hex;
  };

  return {
    zgRouterKey: need('ZG_ROUTER_KEY'),
    baseSepoliaPrivateKey: needHex('BASE_SEPOLIA_PRIVATE_KEY', 64),
    zgPrivateKey: needHex('ZG_PRIVATE_KEY', 64),
    baseSepoliaRpc: need('BASE_SEPOLIA_RPC_URL'),
    zgRpc: need('ZG_RPC_URL'),
    feeSplitter: needHex('FEE_SPLITTER_ADDRESS', 40) as unknown as Address,
    agentRegistry: needHex('AGENT_REGISTRY_ADDRESS', 40) as unknown as Address,
    usdc: (process.env.USDC_BASE_SEPOLIA_ADDRESS ??
      '0x036CbD53842c5426634e7929541eC2318f3dCF7e') as Address,
    oracleOwner: needHex('ORACLE_OWNER_ADDRESS', 40) as unknown as Address,
    // KeeperHub marketplace config. When KH_MARKETPLACE_SLUG is set, all
    // four KH_AUTHOR_* vars must be set too. Otherwise we fall back to
    // the direct-FeeSplitter path.
    keeperhub: process.env.KH_MARKETPLACE_SLUG
      ? {
          subOrgId: need('KH_AUTHOR_SUBORG_ID'),
          walletAddress: needHex('KH_AUTHOR_WALLET', 40) as unknown as Address,
          hmacSecret: need('KH_AUTHOR_HMAC_SECRET'),
          marketplaceSlug: process.env.KH_MARKETPLACE_SLUG,
          baseUrl: process.env.KEEPERHUB_API_URL,
        }
      : undefined,
    spendCap: process.env.SPEND_CAP_ADDRESS
      ? (needHex('SPEND_CAP_ADDRESS', 40) as unknown as Address)
      : undefined,
  };
}
