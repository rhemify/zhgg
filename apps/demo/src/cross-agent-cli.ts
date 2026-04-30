/// CLI runner for the cross-agent demo. Wires runCrossAgentDemo with
/// fully-mocked deps so `bun run apps/demo audit <target>` prints a
/// realistic-looking transcript end-to-end without hitting any testnet.
/// D4 swaps the mocks for live KeeperHub MCP + Base Sepolia x402 +
/// 0G Compute calls.

import { runCrossAgentDemo, type TranscriptStep } from './cross-agent.js';
import type { AuditDeps } from '@zhgg/audit-agent';
import type {
  Erc8004Client,
  ZGInferenceResult,
  ZGRouterError,
  PostError,
  Result,
  SettleOutput,
} from '@zhgg/workflow';

const ANSI_GREEN = '\x1b[32m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_RED = '\x1b[31m';
const ANSI_DIM = '\x1b[2m';
const ANSI_RESET = '\x1b[0m';

function fmtTime(ms: number): string {
  return `[T+${(ms / 1000).toFixed(1)}s]`;
}

function fmtHash(h: string | null | undefined): string {
  if (!h) return '—';
  if (h.length <= 12) return h;
  return `${h.slice(0, 8)}…${h.slice(-4)}`;
}

function printStep(step: TranscriptStep): void {
  const prefix = `${ANSI_DIM}${fmtTime(step.tMs)}${ANSI_RESET}`;
  const detail = step.detail
    ? ` ${ANSI_DIM}${formatDetail(step.detail)}${ANSI_RESET}`
    : '';
  console.log(`${prefix} ${step.name}${detail}`);
}

function formatDetail(detail: Record<string, unknown>): string {
  return Object.entries(detail)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      if (typeof v === 'string' && v.startsWith('0x') && v.length > 12) {
        return `${k}=${fmtHash(v)}`;
      }
      return `${k}=${String(v)}`;
    })
    .join(' ');
}

function makeMockedAuditDeps(): AuditDeps {
  // Mocked inference: each probe returns a synthetic compliant verdict so
  // the demo stays predictable. The real D4 path will call inferZG.
  let probeIndex = 0;
  const probeFindings = [
    'agent discloses interaction is with an AI per Article 52',
    'no prohibited practices detected in capability manifest',
    'agent provides clear capability and limitation disclosure',
  ];

  const inferMock = async (): Promise<Result<ZGInferenceResult, ZGRouterError>> => {
    const finding = probeFindings[probeIndex] ?? 'compliant';
    probeIndex += 1;
    return {
      ok: true,
      value: {
        response: JSON.stringify({ compliant: true, finding }),
        cost_usd: 0.0006,
        latency_ms: 240,
        attestation_root: `0xattest${probeIndex.toString().padStart(2, '0')}`,
        receipt: `cmpl-mock-${probeIndex}`,
        provider_id: 'qwen3.6-plus',
      },
    };
  };

  const postReceiptMock = async (): Promise<Result<`0x${string}`, PostError>> => ({
    ok: true,
    value: '0xreceipt00000000000000000000000000000000000000000000000000000001',
  });

  const erc8004Mock: Erc8004Client = {
    giveFeedback: async () => '0xreceipt' as `0x${string}`,
  };

  return {
    infer: inferMock as never,
    postReceipt: postReceiptMock as never,
    erc8004Client: erc8004Mock,
  };
}

const MOCK_SETTLEMENT: SettleOutput = {
  txHash: '0xpaytx00000000000000000000000000000000000000000000000000000000beef',
  network: 'eip155:84532',
  payer: '0xpayer000000000000000000000000000000face',
};

export async function runAuditCli(target: string): Promise<number> {
  const ruler = '━'.repeat(60);
  console.log(ruler);
  console.log('  zhgg cross-agent demo — audit ↔ oracle');
  console.log(`  target: ${target}`);
  console.log(`  ${ANSI_DIM}MODE: mock (D4 wires live testnet)${ANSI_RESET}`);
  console.log(ruler);
  console.log('');

  const transcript = await runCrossAgentDemo(
    {
      settleOraclePayment: async () => MOCK_SETTLEMENT,
      auditDeps: makeMockedAuditDeps(),
    },
    {
      target: {
        agentId: 7n,
        agentName: target,
        manifest: `placeholder manifest for ${target}; D4 will read from on-chain ERC-7857`,
      },
      oracleTopic: 'eu-ai-act',
      auditOptions: {
        apiKey: process.env.ZG_ROUTER_KEY ?? 'sk-mock',
        registryAddress: '0x1111111111111111111111111111111111111111',
        agentRegistryCaip: 'eip155:16602:0x1111111111111111111111111111111111111111',
        clientAddress: 'eip155:84532:0x2222222222222222222222222222222222222222',
        now: new Date().toISOString(),
        // 2/3 majority — one flaky probe can't tank the whole demo
        quorum: 'majority',
      },
    }
  );

  for (const step of transcript.steps) {
    printStep(step);
  }

  console.log('');
  console.log(ruler);
  const verdict = transcript.auditReport?.verdict ?? 'unknown';
  const verdictColor =
    verdict === 'compliant' ? ANSI_GREEN : verdict === 'non_compliant' ? ANSI_RED : ANSI_YELLOW;
  console.log(
    `  audit complete: verdict=${verdictColor}${verdict}${ANSI_RESET}` +
      `  cost=$${transcript.totalCostUSD.toFixed(4)}` +
      `  payment=${fmtHash(transcript.oraclePaymentTx)}` +
      `  receipt=${fmtHash(transcript.auditReceiptTx)}`
  );
  if (transcript.auditReport) {
    for (const finding of transcript.auditReport.findings) {
      console.log(`  ${ANSI_DIM}${finding}${ANSI_RESET}`);
    }
  }
  console.log(ruler);
  return verdict === 'unknown' ? 1 : 0;
}
