/// CLI runner for the cross-agent demo. Wires runCrossAgentDemo with
/// fully-mocked deps so `bun run apps/demo audit <target>` prints a
/// realistic-looking transcript end-to-end without hitting any testnet.
/// D4 swaps the mocks for live KeeperHub MCP + Base Sepolia x402 +
/// 0G Compute calls.

import { runCrossAgentDemo, type TranscriptStep } from './cross-agent.js';
import { buildLiveDeps, readLiveConfigFromEnv } from './live-deps.js';
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
  // Mocked inference for offline / fast-iteration runs. Returns synthetic
  // compliant verdicts so the demo transcript is deterministic. Critical
  // honesty: `attestation_root: null` — no fabricated TEE attestation
  // gets fed into the on-chain receipt. The receipt JSON's `attestation`
  // sub-object will be omitted entirely (per buildFeedbackJson's
  // null-skip rule), making it impossible to confuse with a live run.
  let probeIndex = 0;
  const probeFindings = [
    'agent discloses interaction is with an AI per Article 50',
    'agent does not engage in any practice prohibited under Article 5',
    'agent provides clear capability and limitation disclosure per Article 13',
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
        // Null in mock — never fabricate a TEE attestation root that ends
        // up on-chain. Live mode (live-deps.ts) populates this from the
        // real 0G Compute response header.
        attestation_root: null,
        receipt: `cmpl-mock-${probeIndex}`,
        provider_id: 'qwen3.6-plus-mock',
      },
    };
  };

  const postReceiptMock = async (): Promise<Result<`0x${string}`, PostError>> => ({
    ok: true,
    // Fixed sentinel value with `mock` byte prefix so anyone scanning the
    // transcript can spot it. Real live mode returns 32-byte hashes from
    // the chain; this is intentionally distinguishable.
    value: '0x6d6f636b00000000000000000000000000000000000000000000000000000001',
  });

  const erc8004Mock: Erc8004Client = {
    giveFeedback: async () =>
      '0x6d6f636b00000000000000000000000000000000000000000000000000000001' as `0x${string}`,
  };

  return {
    infer: inferMock as never,
    postReceipt: postReceiptMock as never,
    erc8004Client: erc8004Mock,
  };
}

// `0x6d6f636b` = ASCII "mock" — anyone scanning the transcript can spot
// this is a synthetic settlement, not a real Base Sepolia tx. Live mode
// builds the real SettleOutput from FeeSplitter.splitERC20's receipt.
const MOCK_SETTLEMENT: SettleOutput = {
  txHash: '0x6d6f636b00000000000000000000000000000000000000000000000000000002',
  network: 'eip155:84532',
  payer: '0x6d6f636b00000000000000000000000000000000',
};

export interface RunAuditCliOptions {
  /// When true, swap mocked deps for real testnet executors. Reads env
  /// for keys + addresses. Fails loudly if env is incomplete.
  live?: boolean;
}

export async function runAuditCli(target: string, opts: RunAuditCliOptions = {}): Promise<number> {
  const live = opts.live ?? false;
  const ruler = '━'.repeat(60);
  console.log(ruler);
  console.log('  zhgg cross-agent demo — audit ↔ oracle');
  console.log(`  target: ${target}`);
  if (live) {
    // "real-settlement" rather than "real-testnet" because live-deps
    // settles via direct FeeSplitter.splitERC20 — not the full x402
    // facilitator round-trip. See live-deps.ts header comment.
    console.log(`  ${ANSI_GREEN}MODE: live (real-settlement testnet path)${ANSI_RESET}`);
  } else {
    console.log(`  ${ANSI_DIM}MODE: mock (synthetic transcript; --live for real settlement)${ANSI_RESET}`);
  }
  console.log(ruler);
  console.log('');

  let bundle:
    | { deps: Parameters<typeof runCrossAgentDemo>[0]; auditOptions: Parameters<typeof runCrossAgentDemo>[1]['auditOptions'] }
    | null = null;
  if (live) {
    try {
      const cfg = readLiveConfigFromEnv();
      bundle = buildLiveDeps(cfg);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`${ANSI_RED}live-mode env error:${ANSI_RESET} ${reason}`);
      return 1;
    }
  }

  const transcript = await runCrossAgentDemo(
    bundle?.deps ?? {
      settleOraclePayment: async () => MOCK_SETTLEMENT,
      auditDeps: makeMockedAuditDeps(),
    },
    {
      target: {
        agentId: 7n,
        agentName: target,
        manifest: `placeholder manifest for ${target}; D5 will read from on-chain ERC-7857`,
      },
      oracleTopic: 'eu-ai-act',
      auditOptions: bundle?.auditOptions ?? {
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
