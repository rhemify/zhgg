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
  paymentFingerprint,
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
  | 'audit.receipt.post';

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

  // 2. Settle oracle payment via injected dep
  const settle = await deps.settleOraclePayment(requirements);
  emit('oracle.payment.settle', {
    txHash: settle?.txHash ?? null,
    network: settle?.network ?? null,
    payer: settle?.payer ?? null,
    fingerprint: paymentFingerprint('orchestrator-' + opts.oracleTopic),
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

  // 5. Run the audit
  emit('audit.start', { agentId: opts.target.agentId.toString() });
  const auditReport = await runAudit(
    { ...opts.target, manifest },
    deps.auditDeps,
    opts.auditOptions
  );
  emit('audit.complete', {
    verdict: auditReport.verdict,
    findingsCount: auditReport.findings.length,
  });
  emit('audit.receipt.post', { txHash: auditReport.receiptTxHash });

  const totalCostUSD = 0.1 + auditReport.results.length * 0.0006; // oracle + 3 inferences

  return {
    steps,
    oraclePaymentTx: settle?.txHash ?? null,
    oracleResponse,
    auditReport,
    auditReceiptTx: auditReport.receiptTxHash,
    totalCostUSD,
  };
}
