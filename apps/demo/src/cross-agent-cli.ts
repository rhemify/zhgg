/// CLI runner for the cross-agent demo. Wires runCrossAgentDemo with
/// fully-mocked deps so `bun run apps/demo audit <target>` prints a
/// realistic-looking transcript end-to-end without hitting any testnet.
/// `--live` swaps the mocks for live KeeperHub MCP + 0G Compute calls
/// and a Base Sepolia settle leg whose rail is `x402` when KH is
/// configured, else `direct_split` (caller-funded FeeSplitter — NOT the
/// x402 protocol).

import { runCrossAgentDemo, type TranscriptStep } from './cross-agent.js';
import { basescanTxUrl, chainscanTxUrl, indexerDownloadUrl, storagescanSubmissionUrl } from './explorer-urls.js';
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
  // Surface block-explorer URLs after each chain-touching step so judges
  // can ⌘+click straight from the transcript. Modern terminals auto-detect
  // URL patterns in stdout; older ones still let you copy-paste the URL.
  for (const url of stepExplorerUrls(step)) {
    console.log(`         ${ANSI_DIM}↳ ${url}${ANSI_RESET}`);
  }
}

/// Returns the explorer URLs for a transcript step, in display order.
/// One step can emit multiple URLs (e.g. `audit.report.pin` shows both
/// the storage rootHash + the upload tx hash).
function stepExplorerUrls(step: TranscriptStep): string[] {
  const d = step.detail ?? {};
  const tx = typeof d.txHash === 'string' && d.txHash.length > 12 ? d.txHash : null;
  const out: string[] = [];
  switch (step.name) {
    case 'oracle.payment.settle':
      if (tx) out.push(basescanTxUrl(tx));
      break;
    case 'audit.axiom.commit':
    case 'audit.axiom.reveal':
    case 'audit.memory_root.pin':
    case 'audit.receipt.post':
      if (tx) out.push(chainscanTxUrl(tx));
      break;
    case 'audit.report.pin': {
      // Prefer storagescan submission URL (indexed by txSeq). Fall back
      // to indexer download URL when txSeq isn't available — exposes the
      // raw bytes even without a browser-friendly view.
      const txSeq = typeof d.txSeq === 'number' ? d.txSeq : null;
      const uri = typeof d.uri === 'string' ? d.uri : null;
      if (txSeq !== null) out.push(storagescanSubmissionUrl(txSeq));
      else if (uri) out.push(indexerDownloadUrl(uri));
      break;
    }
  }
  return out;
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
        // Structured TEE fields — null in mock for the same reason. Live
        // mode populates from `body.trace.tee_verified` + `provider`.
        tee_verified: null,
        tee_provider: null,
        receipt: `cmpl-mock-${probeIndex}`,
        provider_id: 'qwen3.6-plus-mock',
        tee_verified_locally: null,
        tee_verifier_reason: null,
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
  rail: 'direct_split',
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

  // Inline duplicate of apps/tui/src/agent-registry.ts AGENT_REGISTRY.
  // apps can't import sibling apps; keep the lookup consistent so the
  // CLI sends the correct iNFT tokenId + registry agentId to the
  // orchestrator (without this resolver the CLI stamped agentId=7n,
  // which made AxiomCommit revert ERC721NonexistentToken and giveFeedback
  // revert AgentNotFound). See apps/tui/src/agent-registry.ts for the
  // rationale on the dual-id shape.
  const CLI_AGENT_REGISTRY: Record<string, { inftTokenId: bigint; registryAgentId: bigint; ens: string }> = {
    audit:  { inftTokenId: 1n, registryAgentId: 1n, ens: 'audit.zhgg.eth' },
    oracle: { inftTokenId: 2n, registryAgentId: 2n, ens: 'oracle.zhgg.eth' },
    swap:   { inftTokenId: 3n, registryAgentId: 3n, ens: 'swap.zhgg.eth' },
  };
  function resolveCliAgent(name: string) {
    const norm = name.trim().toLowerCase().replace(/\.zhgg\.eth$/i, '');
    return CLI_AGENT_REGISTRY[norm] ?? null;
  }
  const resolved = resolveCliAgent(target);
  // Fall back to (1n, 1n) only if the user passed an unknown role —
  // the orchestrator then audits a non-existent iNFT, surfaced as a
  // loud failure the user can fix by minting first.
  const subjectInftTokenId = resolved?.inftTokenId ?? 1n;
  const subjectRegistryAgentId = resolved?.registryAgentId ?? 1n;

  const transcript = await runCrossAgentDemo(
    bundle?.deps ?? {
      settleOraclePayment: async () => MOCK_SETTLEMENT,
      auditDeps: makeMockedAuditDeps(),
    },
    {
      target: {
        agentId: subjectInftTokenId,
        registryAgentId: subjectRegistryAgentId,
        agentName: resolved ? Object.keys(CLI_AGENT_REGISTRY).find((k) => CLI_AGENT_REGISTRY[k] === resolved)! : target,
        manifest: `placeholder manifest for ${target}; capabilities flow into manifest in the orchestrator's readCapabilities step`,
      },
      // Slice Y — populate the auditor identity from the audit role's
      // iNFT (tokenId 1) when live config is available. Pre-fix every
      // auditorAgent field stamped zero/placeholder; now the canonical
      // AuditReport carries real on-chain identity for the auditor.
      // Only fires in live mode — mock runs keep placeholder so tests
      // don't depend on env.
      auditorIdentity: live && bundle
        ? (() => {
            const auditEntry = CLI_AGENT_REGISTRY.audit!;
            return {
              iNFTAddress: (process.env.AGENT_NFT_ADDRESS ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
              tokenId: auditEntry.inftTokenId,
              ens: auditEntry.ens,
              // Manifest hash deferred — would require an extra readCapabilities
              // call against the audit iNFT. ZERO_HASH placeholder is honest
              // ("not read") and downstream verifiers can re-derive on demand.
              manifestHash: `0x${'0'.repeat(64)}` as `0x${string}`,
              // The deployer EOA owns all 3 demo iNFTs; ORACLE_OWNER_ADDRESS
              // is the same wallet (per .env.example).
              owner: (process.env.ORACLE_OWNER_ADDRESS ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
            };
          })()
        : undefined,
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
  // Verifiable artefacts — full clickable URLs for every chain anchor a
  // regulator / judge would want to inspect. Order matches the audit flow:
  // payment → storage → receipt. Skipped silently when null (e.g. mock
  // mode produces sentinel hashes that aren't real explorer-resolvable).
  console.log('');
  console.log(`  ${ANSI_DIM}verifiable artefacts:${ANSI_RESET}`);
  if (transcript.oraclePaymentTx && /^0x[0-9a-fA-F]{64}$/.test(transcript.oraclePaymentTx)) {
    console.log(`    payment (Base Sepolia): ${basescanTxUrl(transcript.oraclePaymentTx)}`);
  }
  // Storage anchor — find the audit.report.pin step's txSeq for the
  // canonical /submission/<txSeq> URL. Falls back to the raw indexer
  // download URL if the run produced a rootHash but no submission seq.
  const pinStep = transcript.steps.find((s) => s.name === 'audit.report.pin');
  const pinTxSeq = typeof pinStep?.detail?.txSeq === 'number' ? pinStep.detail.txSeq : null;
  const storageURI = transcript.canonicalAuditReport?.anchors.storageURI;
  if (pinTxSeq !== null) {
    console.log(`    audit report (0G Storage): ${storagescanSubmissionUrl(pinTxSeq)}`);
  } else if (storageURI && storageURI.length > 0) {
    console.log(`    audit report (raw bytes): ${indexerDownloadUrl(storageURI)}`);
  }
  if (transcript.auditReceiptTx && /^0x[0-9a-fA-F]{64}$/.test(transcript.auditReceiptTx)) {
    console.log(`    ERC-8004 receipt (0G):    ${chainscanTxUrl(transcript.auditReceiptTx)}`);
  }
  console.log(ruler);
  return verdict === 'unknown' ? 1 : 0;
}
