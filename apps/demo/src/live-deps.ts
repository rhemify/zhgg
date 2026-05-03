/// Live testnet executor — replaces mocked deps with real viem clients,
/// real 0G Compute Router calls, real FeeSplitter settlements, real
/// ERC-8004 receipt posts. Used by `bun run apps/demo audit --live`.
///
/// Settlement has two distinct rails (the orchestrator's transcript
/// surfaces which one fired via `SettleOutput.rail`):
///   - `x402`        — keeperhub marketplace facilitator (real x402
///                     protocol: EIP-3009 transferWithAuthorization,
///                     30/70 KH cut). Engaged when `cfg.keeperhub` is set.
///   - `direct_split` — caller-funded `FeeSplitter.splitERC20`. Same
///                     observable end state on basescan (USDC moved with
///                     the 4-leg 85/5/5/5 split), but NOT x402 protocol
///                     — no facilitator, no EIP-3009. This is the
///                     default path for cheap-demo runs.

import {
  createPublicClient,
  createWalletClient,
  http,
  maxUint256,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  inferZG,
  postReceipt,
  writeAuditLog,
  type AuditLogPayload,
  type Erc8004Client,
  type GiveFeedbackArgs,
  type Storage0GClient,
} from '@zhgg/workflow';
import { createZGStorageClient } from '@zhgg/workflow/storage-log-zg';
import type { AuditDeps } from '@zhgg/audit-agent';
import type { CrossAgentDemoDeps } from './cross-agent.js';
import { payViaKeeperHubMarketplace, type KeeperHubMarketplaceConfig } from './keeperhub-marketplace.js';
import { checkSpendCap } from './spend-cap.js';
import {
  readAgentCapabilities,
  commitPlan as axiomCommitFn,
  revealPlan as axiomRevealFn,
  pinMemoryRoot as pinMemoryRootFn,
} from './loop-helpers.js';
import { syntheticInferImpl } from './live-deps-mock.js';

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
  /// 0G Compute Router API key. When absent, audit inference falls back
  /// to a synthetic provider (deterministic, prefixed with `0x6d6f636b`
  /// "mock" so it can never be confused with a real run) — every other
  /// live primitive (FeeSplitter, AgentRegistry, AxiomCommit, OwnerMirror)
  /// still hits real testnet contracts. Sign up at https://pc.0g.ai for
  /// real Qwen TEE inference.
  zgRouterKey: string | undefined;
  /// Base Sepolia signer — pays 0.1 USDC to the FeeSplitter per audit.
  baseSepoliaPrivateKey: Hex;
  /// 0G Galileo signer — posts ERC-8004 receipts. Often the same key as
  /// Base Sepolia (same EOA across chains is fine for EVM).
  zgPrivateKey: Hex;
  /// Optional separate signer for ERC-8004 giveFeedback. When set, this
  /// account posts receipts instead of zgPrivateKey — required when the
  /// zgPrivateKey account also OWNS the agent NFT (AgentRegistry reverts
  /// with SelfFeedbackForbidden when caller == owner). Fund this address
  /// with a small amount of 0G testnet gas from https://faucet.0g.ai.
  zgFeedbackPrivateKey?: Hex;
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
  /// Optional — when set, enables Step 1 (read capabilities) + Step 9
  /// (memoryRoot pin). Address of the AgentNFT (ERC-7857) on 0G Galileo.
  agentNft?: Address;
  /// Optional — when set, enables Step 3 (AXIOM commit) + Step 10
  /// (AXIOM reveal). Address of `AxiomCommit.sol` on 0G Galileo.
  axiomCommit?: Address;
  /// Optional — when true, audit logs are persisted to 0G Storage Log
  /// via the SDK adapter. Required for Step 8, which produces the
  /// `rootHash` consumed by Step 9 (memoryRoot pin). When false, both
  /// Step 8 and Step 9 silently no-op.
  zgStorageEnabled?: boolean;
  /// Optional — override for the 0G Storage indexer RPC. Defaults to
  /// the Galileo Turbo indexer in the SDK adapter.
  zgIndexerRpc?: string;
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
  // Use a separate feedback account when ZG_FEEDBACK_PRIVATE_KEY is set.
  // AgentRegistry reverts SelfFeedbackForbidden when caller == NFT owner,
  // so the feedback poster must be a different address than the agent minter.
  const zgFeedbackAccount = cfg.zgFeedbackPrivateKey
    ? privateKeyToAccount(cfg.zgFeedbackPrivateKey)
    : zgAccount;
  const baseTransport = http(cfg.baseSepoliaRpc);
  const zgTransport = http(cfg.zgRpc);
  const baseWallet = createWalletClient({ account: baseAccount, transport: baseTransport });
  const basePub = createPublicClient({ transport: baseTransport });
  const zgWallet = createWalletClient({ account: zgAccount, transport: zgTransport });
  const zgFeedbackWallet = createWalletClient({ account: zgFeedbackAccount, transport: zgTransport });
  const zgPub = createPublicClient({ transport: zgTransport });

  // Real ERC-8004 client: writes giveFeedback to AgentRegistry on 0G.
  const erc8004Client: Erc8004Client = {
    giveFeedback: async (args: GiveFeedbackArgs): Promise<Hex> => {
      const sim = await zgPub.simulateContract({
        account: zgFeedbackAccount,
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
      const txHash = await zgFeedbackWallet.writeContract(sim.request);
      // Fire-and-forget — 0G nodes reject receipt polls immediately for
      // pending txs. The tx is submitted; we return the hash so the audit
      // trail shows it, and the background poller catches confirmation.
      zgPub
        .waitForTransactionReceipt({ hash: txHash, timeout: 300_000, pollingInterval: 2_000 })
        .catch(() => { /* non-fatal */ });
      return txHash;
    },
  };

  // Real audit deps when ZG_ROUTER_KEY is set; synthetic fallback when
  // it isn't (settlement, AXIOM, receipt, memoryRoot still hit real
  // testnet contracts — only the inference leg is synthetic). Synthetic
  // responses are prefixed with `0x6d6f636b` ("mock" in ASCII) so any
  // observer can spot them instantly.
  const inferImpl: AuditDeps['infer'] = cfg.zgRouterKey
    ? ((prompt, opts) =>
        inferZG(prompt, {
          apiKey: opts.apiKey,
          // Real TEE verification on every probe — router does the
          // on-chain signature check and returns trace.tee_verified.
          verifyTee: true,
        }))
    : syntheticInferImpl;
  const auditDeps: AuditDeps = {
    infer: inferImpl,
    postReceipt,
    erc8004Client,
  };

  // Settlement has two rails (set via SettleOutput.rail so observers can
  // tell them apart in the transcript):
  //  - cfg.keeperhub set → `x402`        (KH marketplace facilitator,
  //                                       30/70 split, real EIP-3009)
  //  - else            → `direct_split` (caller-funded FeeSplitter, full
  //                                       85/5/5/5 — NOT x402 protocol)
  const settleOraclePayment: CrossAgentDemoDeps['settleOraclePayment'] = async (_req, agentName) => {
    if (cfg.keeperhub) {
      // Real marketplace path — KH facilitator settles EIP-3009 on Base,
      // takes 30%, sends 70% to keeperhub.walletAddress (Turnkey custody).
      // The 85/5/5/5 sub-split on the 70% is a documented manual step
      // for V1 since the receiving wallet is server-custodied.
      const settlement = await payViaKeeperHubMarketplace(cfg.keeperhub, {
        agentName,
      });
      return {
        txHash: settlement.paymentTxHash,
        network: settlement.network,
        payer: settlement.payerAddress,
        rail: 'x402',
      };
    }

    // Fallback path: caller-funds direct FeeSplitter call.
    // Approve maxUint256 once — avoids the stale-allowance race where an
    // exact-amount approval is consumed and the RPC node hasn't propagated
    // the new approval before the next simulate call runs.
    {
      const currentAllowance = await basePub.readContract({
        address: cfg.usdc,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [baseAccount.address, cfg.feeSplitter],
      }) as bigint;
      if (currentAllowance < ORACLE_PAYMENT_ATOMIC) {
        const sim = await basePub.simulateContract({
          account: baseAccount,
          address: cfg.usdc,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [cfg.feeSplitter, maxUint256],
        });
        const approveTx = await baseWallet.writeContract(sim.request);
        await basePub.waitForTransactionReceipt({ hash: approveTx });
      }
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
      rail: 'direct_split',
    };
  };

  // Spend-cap pre-flight gate. Closure captures `baseAccount.address` as
  // the capped account so the orchestrator stays wallet-agnostic. When
  // the live config has no spendCap address, this is a no-op fail-open
  // check (matches the mocked-mode default).
  const checkSpendCapDep: CrossAgentDemoDeps['checkSpendCap'] = async ({
    amount,
    enforce,
    permissionId,
  }) =>
    checkSpendCap({
      spendCapAddress: cfg.spendCap ?? null,
      account: baseAccount.address,
      asset: cfg.usdc,
      amount,
      publicClient: basePub,
      walletClient: baseWallet,
      enforce,
      permissionId,
    });

  // Loop helpers — Steps 1, 3, 9, 10. Each fails-open (returns
  // `not_configured`) when its address env var is unset, so partial-live
  // demos run without these without changing orchestrator behavior.
  const readCapabilitiesDep: CrossAgentDemoDeps['readCapabilities'] = async (tokenId) => {
    const r = await readAgentCapabilities({
      agentNftAddress: cfg.agentNft ?? null,
      tokenId,
      publicClient: zgPub,
    });
    return r.ok
      ? { ok: true, manifest: r.value }
      : { ok: false, error: r.error.kind };
  };

  const axiomCommitDep: CrossAgentDemoDeps['axiomCommit'] = async ({ tokenId, plan }) => {
    const r = await axiomCommitFn({
      axiomAddress: cfg.axiomCommit ?? null,
      tokenId,
      plan,
      publicClient: zgPub,
      walletClient: zgWallet,
    });
    return r.ok
      ? { ok: true, commitId: r.value.commitId, txHash: r.value.txHash }
      : { ok: false, error: r.error.kind === 'commit_failed' ? r.error.reason : r.error.kind };
  };

  const axiomRevealDep: CrossAgentDemoDeps['axiomReveal'] = async ({
    tokenId,
    commitId,
    plan,
    result,
  }) => {
    const r = await axiomRevealFn({
      axiomAddress: cfg.axiomCommit ?? null,
      tokenId,
      commitId,
      plan,
      result,
      publicClient: zgPub,
      walletClient: zgWallet,
    });
    return r.ok
      ? { ok: true, txHash: r.value.txHash }
      : { ok: false, error: r.error.kind === 'reveal_failed' ? r.error.reason : r.error.kind };
  };

  const pinMemoryRootDep: CrossAgentDemoDeps['pinMemoryRoot'] = async ({ tokenId, rootHash }) => {
    const r = await pinMemoryRootFn({
      agentNftAddress: cfg.agentNft ?? null,
      tokenId,
      rootHash,
      publicClient: zgPub,
      walletClient: zgWallet,
    });
    return r.ok ? { ok: true, txHash: r.value.txHash } : { ok: false, error: r.error.kind };
  };

  // Step 8 — write canonical audit JSON to 0G Storage Log. Constructed
  // here (lazy: the SDK + ethers v6 only resolve when this dep fires)
  // so mocked-mode runs never touch the storage adapter at all. When
  // `zgStorageEnabled` is false, the dep is undefined and the
  // orchestrator skips Step 8 (and Step 9, which depends on its rootHash).
  // The same client is also exposed as `zgStorageClient` to power the
  // Slice-Y canonical AuditReport writer (consumed by the orchestrator's
  // `buildFeedbackAnchor` closure).
  let writeStorageLogDep: CrossAgentDemoDeps['writeStorageLog'] | undefined;
  let zgStorageClient: Storage0GClient | undefined;
  if (cfg.zgStorageEnabled) {
    zgStorageClient = createZGStorageClient({
      privateKey: cfg.zgPrivateKey,
      rpcUrl: cfg.zgRpc,
      indexerUrl: cfg.zgIndexerRpc,
    });
    const client = zgStorageClient;
    writeStorageLogDep = async (report) => {
      const payload: AuditLogPayload = {
        version: '1',
        auditedAt: new Date().toISOString(),
        agentId: report.target.agentId,
        probe: {
          verdict: report.verdict,
          findings: report.findings,
          resultCount: report.results.length,
        },
        attestationRoot: report.attestationRoot,
        // The cross-agent transcript carries the on-chain payment + receipt
        // tx hashes; the AuditReport itself only knows the receipt. Payment
        // tx is logged separately on the transcript and not pinned to the
        // audit log payload (Step 8 is about the audit's evidence chain,
        // not the payment ledger).
        paymentTxHash: null,
        receiptTxHash: report.receiptTxHash as `0x${string}` | null,
      };
      const r = await writeAuditLog(client, payload);
      return r.ok
        ? { ok: true, rootHash: r.value.rootHash }
        : { ok: false, error: r.error.kind };
    };
  }

  return {
    deps: {
      settleOraclePayment,
      auditDeps,
      checkSpendCap: checkSpendCapDep,
      readCapabilities: readCapabilitiesDep,
      axiomCommit: axiomCommitDep,
      axiomReveal: axiomRevealDep,
      pinMemoryRoot: pinMemoryRootDep,
      writeStorageLog: writeStorageLogDep,
      // Slice Y — share the same 0G client + flag with the orchestrator's
      // canonical AuditReport writer. When zgStorageEnabled is false the
      // client is undefined and writeAuditReport refuses with
      // `storage_disabled` (no fake URI fallback).
      zgStorageClient,
      zgStorageEnabled: cfg.zgStorageEnabled === true,
    },
    auditOptions: {
      // When zgRouterKey is undefined we're in synthetic-inference
      // mode — `inferImpl` ignores the key, so passing the literal
      // 'sk-mock' is just a placeholder for the type.
      apiKey: cfg.zgRouterKey ?? 'sk-mock',
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
    zgRouterKey: process.env.ZG_ROUTER_KEY && process.env.ZG_ROUTER_KEY.length > 0
      ? process.env.ZG_ROUTER_KEY
      : undefined,
    baseSepoliaPrivateKey: needHex('BASE_SEPOLIA_PRIVATE_KEY', 64),
    zgPrivateKey: needHex('ZG_PRIVATE_KEY', 64),
    zgFeedbackPrivateKey: process.env.ZG_FEEDBACK_PRIVATE_KEY
      ? (needHex('ZG_FEEDBACK_PRIVATE_KEY', 64))
      : undefined,
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
    agentNft: process.env.AGENT_NFT_ADDRESS
      ? (needHex('AGENT_NFT_ADDRESS', 40) as unknown as Address)
      : undefined,
    axiomCommit: process.env.AXIOM_COMMIT_ADDRESS
      ? (needHex('AXIOM_COMMIT_ADDRESS', 40) as unknown as Address)
      : undefined,
    zgStorageEnabled: process.env.ZG_STORAGE_ENABLED === '1',
    zgIndexerRpc: process.env.ZG_INDEXER_RPC,
  };
}
