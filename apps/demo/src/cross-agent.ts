/// Cross-agent demo orchestrator: audit ↔ oracle.
///
/// audit pays oracle 0.1 USDC (rail TBD by injected `settleOraclePayment`
/// — `x402` if keeperhub is configured, `direct_split` otherwise; the
/// rail is reported back on the `oracle.payment.settle` transcript step
/// via `SettleOutput.rail`). Oracle returns regulatory deltas → audit
/// runs TEE compliance audit on a target → audit posts an ERC-8004
/// receipt. All external systems (facilitator, KeeperHub MCP, 0G compute,
/// ERC-8004 chain) are dependency-injected so this module runs
/// end-to-end with mocked deps in tests.

import { EventEmitter } from 'node:events';
import { runAudit, type AuditDeps, type AuditReport, type AuditTarget } from '@zhgg/audit-agent';
import { queryOracle, type OracleQuery, type OracleResponse } from '@zhgg/oracle-agent';
import {
  buildPaymentRequirements,
  type SettleOutput,
  type PaymentRequirements,
} from '@zhgg/workflow';
import { keccak256, toHex } from 'viem';

export type TranscriptStepName =
  | 'oracle.spend_cap.check'
  | 'oracle.spend_cap.exceeded'
  | 'oracle.payment.request'
  | 'oracle.payment.settle'
  | 'oracle.query.start'
  | 'oracle.query.complete'
  | 'audit.capabilities.read'
  | 'audit.axiom.commit'
  | 'audit.axiom.reveal'
  | 'audit.memory_root.pin'
  | 'audit.start'
  | 'audit.complete'
  | 'audit.failed'
  | 'audit.receipt.post'
  | 'audit.receipt.failed';

export interface TranscriptStep {
  /// Milliseconds since the orchestrator started. Use the elapsed time as
  /// a relative timestamp in CLIs (`[T+0.4s]`).
  tMs: number;
  name: TranscriptStepName;
  detail?: Record<string, unknown>;
}

export interface CrossAgentTranscript {
  steps: TranscriptStep[];
  oraclePaymentTx: string | null;
  oracleResponse: OracleResponse;
  auditReport: AuditReport | null;
  auditReceiptTx: string | null;
  totalCostUSD: number;
  /// True when the oracle payment settled but the audit threw or the audit
  /// report itself was unrecoverable. The user paid for work that didn't
  /// complete — surface this loudly so the demo / TUI / refund tooling can
  /// react. (No automated refund: both rails — x402 facilitator settlement
  /// and direct FeeSplitter calls — are final on-chain.)
  refundable: boolean;
  /// Captured audit-stage error message when `refundable === true`.
  auditError: string | null;
}

export interface SpendCapCheckResult {
  ok: boolean;
  reason?: string;
  remaining?: bigint;
  requested?: bigint;
  enforced?: boolean;
  spendTx?: `0x${string}`;
}

export interface CrossAgentDemoDeps {
  /// Settle a payment for the oracle leg. Returns null if settlement is
  /// disabled in this run (e.g. dry-run mode).
  settleOraclePayment: (req: PaymentRequirements) => Promise<SettleOutput | null>;
  /// audit's runtime — injected so the orchestrator never imports inferZG /
  /// postReceipt directly.
  auditDeps: AuditDeps;
  /// Optional ERC-7715 spend-cap pre-flight gate. When provided, called
  /// BEFORE `settleOraclePayment` to fail-closed if the caller's daily
  /// USDC budget is exhausted. Step 2 of the always-active loop. The
  /// orchestrator passes a `permissionId` derived from the oracle topic
  /// so each workflow scopes against an independent cap.
  checkSpendCap?: (args: {
    amount: bigint;
    enforce: boolean;
    permissionId: `0x${string}`;
  }) => Promise<SpendCapCheckResult>;
  /// Step 1 — read iNFT capability manifest before any external call.
  readCapabilities?: (
    tokenId: bigint
  ) => Promise<{ ok: boolean; manifest?: `0x${string}`; error?: string }>;
  /// Step 3 — pre-commit `keccak256(plan)` before runAudit. Hash-only
  /// on-chain; the bytes are revealed at Step 10.
  axiomCommit?: (args: {
    tokenId: bigint;
    plan: Uint8Array;
  }) => Promise<{ ok: boolean; commitId?: `0x${string}`; txHash?: `0x${string}`; error?: string }>;
  /// Step 10 — reveal plan + result after receipt post.
  axiomReveal?: (args: {
    tokenId: bigint;
    commitId: `0x${string}`;
    plan: Uint8Array;
    result: Uint8Array;
  }) => Promise<{ ok: boolean; txHash?: `0x${string}`; error?: string }>;
  /// Step 9 — pin storage rootHash to iNFT memoryRoot.
  pinMemoryRoot?: (args: {
    tokenId: bigint;
    rootHash: `0x${string}`;
  }) => Promise<{ ok: boolean; txHash?: `0x${string}`; error?: string }>;
  /// Step 8 — write canonical audit JSON to 0G Storage Log; returns
  /// `rootHash` consumed by Step 9.
  writeStorageLog?: (
    report: AuditReport
  ) => Promise<{ ok: boolean; rootHash?: `0x${string}`; error?: string }>;
}

export interface CrossAgentDemoOpts {
  target: AuditTarget;
  oracleTopic: OracleQuery['topic'];
  /// Atomic units of USDC charged by the oracle. Default 100000 (0.1 USDC).
  oracleAmountAtomic?: string;
  /// Address that receives the 85% bulk of the oracle's fee (the oracle
  /// agent's iNFT owner). Defaults to a placeholder so demos run
  /// without env config.
  oracleOwner?: `0x${string}`;
  /// FeeSplitter contract address — the direct_split rail's settlement
  /// target. (The x402 rail through KeeperHub uses its own facilitator
  /// contract instead.)
  feeSplitter?: `0x${string}`;
  /// USDC contract address on Base Sepolia.
  asset?: `0x${string}`;
  /// CAIP-2 chain — settlement chain (Base Sepolia for hackathon demo).
  network?: string;
  /// Audit options (api keys, registry address, etc.) forwarded to runAudit.
  auditOptions: Parameters<typeof runAudit>[2];
  /// Optional event emitter so the TUI (D3.5) can subscribe live. If
  /// omitted, the orchestrator creates its own and discards it.
  events?: EventEmitter;
}

const DEFAULT_AMOUNT_ATOMIC = '100000'; // 0.1 USDC at 6 decimals
const DEFAULT_OWNER: `0x${string}` = '0x000000000000000000000000000000000000beef';
const DEFAULT_SPLITTER: `0x${string}` = '0x000000000000000000000000000000000000feed';
const DEFAULT_USDC: `0x${string}` = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const DEFAULT_NETWORK = 'eip155:84532';

export async function runCrossAgentDemo(
  deps: CrossAgentDemoDeps,
  opts: CrossAgentDemoOpts
): Promise<CrossAgentTranscript> {
  const start = Date.now();
  const events = opts.events ?? new EventEmitter();
  const steps: TranscriptStep[] = [];

  const emit = (name: TranscriptStepName, detail?: Record<string, unknown>) => {
    const step: TranscriptStep = { tMs: Date.now() - start, name, detail };
    steps.push(step);
    events.emit(name, step);
  };

  // 1. Build payment requirements for the oracle query
  const requirements = buildPaymentRequirements({
    amount: opts.oracleAmountAtomic ?? DEFAULT_AMOUNT_ATOMIC,
    payTo: opts.feeSplitter ?? DEFAULT_SPLITTER,
    asset: opts.asset ?? DEFAULT_USDC,
    network: opts.network ?? DEFAULT_NETWORK,
    resource: {
      url: 'https://oracle.zhgg.eth/query',
      description: `oracle.query topic=${opts.oracleTopic}`,
    },
  });
  emit('oracle.payment.request', { amount: requirements.accepts[0]?.amount ?? null });

  // 1.5 Pre-flight ERC-7715 spend-cap gate (Step 2 of the always-active
  //     loop). Read-only by default; live mode can flip enforce=true to
  //     atomically debit the cap so two concurrent runs can't both pass
  //     the read and double-spend. Fail-closed BEFORE money moves.
  if (deps.checkSpendCap) {
    const amountAtomic = BigInt(opts.oracleAmountAtomic ?? DEFAULT_AMOUNT_ATOMIC);
    const enforce =
      (opts.auditOptions as Parameters<typeof runAudit>[2] & { enforceSpendCap?: boolean })
        .enforceSpendCap === true;
    // Per-workflow ERC-7715 scope. Hashing the oracle topic gives every
    // workflow a stable, content-derived `permissionId` so the user
    // can grant separate budgets per workflow without orchestrator-side
    // bookkeeping.
    const permissionId = keccak256(toHex(`zhgg.oracle.${opts.oracleTopic}.v1`));
    const capResult = await deps.checkSpendCap({
      amount: amountAtomic,
      enforce,
      permissionId,
    });
    if (!capResult.ok) {
      emit('oracle.spend_cap.exceeded', {
        reason: capResult.reason ?? 'unknown',
        remaining: capResult.remaining?.toString() ?? null,
        requested: capResult.requested?.toString() ?? null,
      });
      return {
        steps,
        oraclePaymentTx: null,
        oracleResponse: { ok: false, error: { kind: 'unknown_topic', topic: opts.oracleTopic } },
        auditReport: null,
        auditReceiptTx: null,
        totalCostUSD: 0,
        refundable: false,
        auditError: `spend cap blocked: ${capResult.reason ?? 'unknown'}`,
      };
    }
    emit('oracle.spend_cap.check', {
      enforced: capResult.enforced ?? false,
      remaining: capResult.remaining?.toString() ?? null,
      spendTx: capResult.spendTx ?? null,
    });
  }

  // 2. Settle oracle payment via injected dep. Replay protection lives one
  // layer down (the verifier-side caller wraps `verifyPayment` with the
  // payment payload's `fingerprint` before calling settle). The
  // orchestrator only knows about the result, not the signed payload, so
  // there's no honest fingerprint to compute here.
  const settle = await deps.settleOraclePayment(requirements);
  emit('oracle.payment.settle', {
    txHash: settle?.txHash ?? null,
    network: settle?.network ?? null,
    payer: settle?.payer ?? null,
    rail: settle?.rail ?? null,
  });

  // 3. Query oracle (called directly — payment already settled)
  emit('oracle.query.start', { topic: opts.oracleTopic });
  const oracleResponse = await queryOracle({ topic: opts.oracleTopic });
  emit('oracle.query.complete', { ok: oracleResponse.ok });

  // 4. Build the audit target's enriched manifest (regulatory context
  //    inlined from the oracle's response).
  let manifest = opts.target.manifest;
  if (oracleResponse.ok && oracleResponse.data.kind === 'regulatory') {
    const ctx = oracleResponse.data.deltas
      .map((d) => `${d.article}: ${d.summary}`)
      .join(' | ');
    manifest = `${opts.target.manifest}\n\nRegulatory context: ${ctx}`;
  }

  // 4.5 Step 1 — read iNFT capability manifest. Read-only, idempotent.
  if (deps.readCapabilities) {
    const cap = await deps.readCapabilities(opts.target.agentId);
    emit('audit.capabilities.read', {
      ok: cap.ok,
      manifestLen: cap.manifest ? (cap.manifest.length - 2) / 2 : 0,
      error: cap.error,
    });
  }

  // 4.6 Step 3 — AXIOM pre-commit. The plan is the canonical intent the
  //     agent has decided to execute, derived from the enriched manifest +
  //     oracle context. Hash-only on chain; bytes revealed at Step 10.
  let axiomCommitId: `0x${string}` | null = null;
  let axiomPlanBytes: Uint8Array | null = null;
  if (deps.axiomCommit) {
    axiomPlanBytes = new TextEncoder().encode(
      JSON.stringify({
        agentId: opts.target.agentId.toString(),
        manifest,
        oracleTopic: opts.oracleTopic,
      })
    );
    const c = await deps.axiomCommit({ tokenId: opts.target.agentId, plan: axiomPlanBytes });
    if (c.ok && c.commitId) {
      axiomCommitId = c.commitId;
      emit('audit.axiom.commit', { commitId: c.commitId, txHash: c.txHash });
    } else {
      emit('audit.axiom.commit', { ok: false, error: c.error });
    }
  }

  // 5. Run the audit. If this throws after settle succeeded, the user paid
  // for work that didn't complete — capture the error in the transcript
  // and flag `refundable` so callers can react. We do NOT swallow the
  // error: the transcript itself is the surface, and exit-code checks at
  // the CLI layer can tell success from this state.
  emit('audit.start', { agentId: opts.target.agentId.toString() });
  let auditReport: AuditReport | null = null;
  let auditError: string | null = null;
  try {
    auditReport = await runAudit(
      { ...opts.target, manifest },
      deps.auditDeps,
      opts.auditOptions
    );
    emit('audit.complete', {
      verdict: auditReport.verdict,
      findingsCount: auditReport.findings.length,
    });
    // Honest post outcome: emit `.post` only when the on-chain write
    // actually returned a tx hash. Null receipt → `.failed`. The
    // transcript previously emitted `.post` with `txHash: null`,
    // looking like a successful post that wasn't.
    if (auditReport.receiptTxHash !== null) {
      emit('audit.receipt.post', { txHash: auditReport.receiptTxHash });
    } else {
      emit('audit.receipt.failed', { reason: 'postReceipt returned null' });
    }
  } catch (e) {
    auditError = e instanceof Error ? e.message : String(e);
    emit('audit.failed', { reason: auditError, paid: settle !== null });
  }

  // 6. Steps 8/9/10 — only fire when the audit posted a real receipt.
  //    Failed audits don't get a memory pin or a reveal: we want the
  //    on-chain trail to encode "this agent did NOT successfully act".
  if (auditReport && auditReport.receiptTxHash !== null) {
    let storageRootHash: `0x${string}` | null = null;
    if (deps.writeStorageLog) {
      const wr = await deps.writeStorageLog(auditReport);
      if (wr.ok && wr.rootHash) storageRootHash = wr.rootHash;
    }

    if (deps.pinMemoryRoot && storageRootHash) {
      const pin = await deps.pinMemoryRoot({
        tokenId: opts.target.agentId,
        rootHash: storageRootHash,
      });
      emit('audit.memory_root.pin', {
        ok: pin.ok,
        rootHash: storageRootHash,
        txHash: pin.txHash ?? null,
        error: pin.error,
      });
    }

    if (deps.axiomReveal && axiomCommitId && axiomPlanBytes) {
      const resultBytes = new TextEncoder().encode(
        JSON.stringify({
          verdict: auditReport.verdict,
          findingsCount: auditReport.findings.length,
          receiptTxHash: auditReport.receiptTxHash,
        })
      );
      const r = await deps.axiomReveal({
        tokenId: opts.target.agentId,
        commitId: axiomCommitId,
        plan: axiomPlanBytes,
        result: resultBytes,
      });
      emit('audit.axiom.reveal', { ok: r.ok, txHash: r.txHash ?? null, error: r.error });
    }
  }

  const probeCount = auditReport?.results.length ?? 0;
  const totalCostUSD = 0.1 + probeCount * 0.0006;
  const refundable = settle !== null && (auditReport === null || auditReport.verdict === 'unclear');

  return {
    steps,
    oraclePaymentTx: settle?.txHash ?? null,
    oracleResponse,
    auditReport,
    auditReceiptTx: auditReport?.receiptTxHash ?? null,
    totalCostUSD,
    refundable,
    auditError,
  };
}
