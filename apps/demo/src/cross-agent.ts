/// Cross-agent demo orchestrator: audit ↔ oracle.
///
/// audit pays oracle 0.1 USDC over x402 → oracle returns regulatory
/// deltas → audit runs TEE compliance audit on a target → audit posts an
/// ERC-8004 receipt. All external systems (facilitator, KeeperHub MCP,
/// 0G compute, ERC-8004 chain) are dependency-injected so this module
/// runs end-to-end with mocked deps in tests.

import { EventEmitter } from 'node:events';
import { runAudit, type AuditDeps, type AuditReport, type AuditTarget } from '@zhgg/audit-agent';
import { queryOracle, type OracleQuery, type OracleResponse } from '@zhgg/oracle-agent';
import {
  buildPaymentRequirements,
  type SettleOutput,
  type PaymentRequirements,
} from '@zhgg/workflow';

export type TranscriptStepName =
  | 'oracle.payment.request'
  | 'oracle.payment.settle'
  | 'oracle.query.start'
  | 'oracle.query.complete'
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
  /// react. (No automated refund: x402 settlements are final on-chain.)
  refundable: boolean;
  /// Captured audit-stage error message when `refundable === true`.
  auditError: string | null;
}

export interface CrossAgentDemoDeps {
  /// Settle a payment for the oracle leg. Returns null if settlement is
  /// disabled in this run (e.g. dry-run mode).
  settleOraclePayment: (req: PaymentRequirements) => Promise<SettleOutput | null>;
  /// audit's runtime — injected so the orchestrator never imports inferZG /
  /// postReceipt directly.
  auditDeps: AuditDeps;
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
  /// FeeSplitter contract address — the x402 settlement target.
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
