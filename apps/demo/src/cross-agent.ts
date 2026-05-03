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
  buildAuditReport,
  buildPaymentRequirements,
  writeAuditReport,
  type AuditReport as CanonicalAuditReport,
  type SettleOutput,
  type PaymentRequirements,
  type Storage0GClient,
  type WriteAuditReportError,
} from '@zhgg/workflow';
import { keccak256, toBytes, toHex, type Address, type Hex } from 'viem';

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
  | 'audit.report.pin'
  | 'audit.report.unpinned'
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
  /// Slice Y — the canonical, hash-anchored audit report produced for this
  /// run. Populated when `buildFeedbackAnchor` fires (always, post-probes).
  /// `anchors.storageURI` is the 0G CID when storage was enabled,
  /// empty-string when ZG_STORAGE was disabled (honest "unpinned" marker).
  /// `anchors.feedbackTx` is stamped after `giveFeedback` returns.
  canonicalAuditReport: CanonicalAuditReport | null;
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
  settleOraclePayment: (req: PaymentRequirements, agentName: string) => Promise<SettleOutput | null>;
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
  }) => Promise<{ ok: boolean; commitId?: `0x${string}`; txHash?: `0x${string}`; commitBlock?: bigint; error?: string }>;
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
  /// Slice Y — 0G Storage adapter for pinning the canonical AuditReport
  /// bytes that the on-chain `feedbackHash` commits to. Distinct from
  /// `writeStorageLog` (which pins the legacy v1 audit-log payload). When
  /// omitted OR when `zgStorageEnabled` is false, the orchestrator emits
  /// `audit.report.unpinned` and posts ERC-8004 with `feedbackURI=""` +
  /// `feedbackHash=0x0…0` — an honest "evidence not yet pinned" signal.
  zgStorageClient?: Storage0GClient;
  /// Toggle from env (`ZG_STORAGE_ENABLED === '1'`). Surfaced as a dep so
  /// the orchestrator can refuse the storage write deterministically in
  /// tests without poking process.env.
  zgStorageEnabled?: boolean;
}

export interface CrossAgentDemoOpts {
  target: AuditTarget;
  oracleTopic: OracleQuery['topic'];
  /// Workflow-audit mode (used by `kh hire` auto-chain). When true:
  /// skip oracle payment + query (probes run against the workflow's
  /// metadata directly), skip capabilities-read (workflow has no on-chain
  /// iNFT), skip AxiomCommit + reveal (contract reverts on tokenId=0
  /// because `agentNft.ownerOf(0)` reverts ERC721NonexistentToken), skip
  /// memoryRoot pin (no subject iNFT), and pass `skipReceiptPost: true`
  /// to runAudit (no AgentRegistry entry). Qwen probes + 0G Storage
  /// anchor + canonical AuditReport STILL fire — the storage URI is the
  /// regulator-readable proof. Phase-2 enhancement: thread auditor
  /// tokenId override so AxiomCommit fires on auditor's iNFT instead.
  auditWorkflowOnly?: boolean;
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
  /// Slice Y — auditor agent identity used to populate the canonical
  /// AuditReport. Defaults pick safe placeholders so tests don't need to
  /// supply this; live deployments override every field.
  auditorIdentity?: {
    iNFTAddress: Address;
    tokenId: bigint;
    ens: string;
    manifestHash: Hex;
    owner: Address;
  };
  /// Slice Y — subject agent metadata pinned into the AuditReport. Block
  /// + capabilities default to placeholders when not known.
  subjectIdentity?: {
    capabilitiesAtAudit?: Hex;
    registeredAtBlock?: string;
    ens?: string;
  };
  /// Slice Y — the regulatory framework + articles probed. Defaults to
  /// EU AI Act 2024/1689 + the three article refs in PROBE_PROMPTS.
  regulation?: {
    framework?: string;
    articlesProbed?: string[];
    regulatorySource?: { type: string; publishedAt?: string; fetchedFromCID?: string };
  };
}

const DEFAULT_AMOUNT_ATOMIC = '100000'; // 0.1 USDC at 6 decimals
const DEFAULT_OWNER: `0x${string}` = '0x000000000000000000000000000000000000beef';
const DEFAULT_SPLITTER: `0x${string}` = '0x000000000000000000000000000000000000feed';
const DEFAULT_USDC: `0x${string}` = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const DEFAULT_NETWORK = 'eip155:84532';

const ZERO_ADDR: Address = '0x0000000000000000000000000000000000000000';
const ZERO_HASH: Hex = `0x${'0'.repeat(64)}` as Hex;
const DEFAULT_ARTICLES = [
  'EU AI Act Article 5 (Regulation 2024/1689)',
  'EU AI Act Article 13 (Regulation 2024/1689)',
  'EU AI Act Article 50 (Regulation 2024/1689)',
];

/// Map probe verdicts to Slice-Y AuditReport finding statuses. `null`
/// (parse failure / unclear) maps to `inconclusive` so the regulator
/// can see the gap rather than a forced pass/fail.
function findingStatus(compliant: boolean | null): 'pass' | 'fail' | 'inconclusive' {
  if (compliant === true) return 'pass';
  if (compliant === false) return 'fail';
  return 'inconclusive';
}

/// Stamp the on-chain `feedbackTx` onto a previously-built canonical
/// audit report. Off-chain mutation only — the bytes pinned at
/// `anchors.storageURI` already exclude `feedbackTx` via
/// canonicalization, so this stamp does not invalidate the stored hash.
/// Pulled out into a top-level fn so TypeScript's narrowing doesn't
/// collapse the branch where `canonicalAuditReport` is captured by an
/// upstream closure.
function stampFeedbackTx(
  report: CanonicalAuditReport | null,
  txHash: string
): CanonicalAuditReport | null {
  if (report === null) return null;
  if (!/^0x[0-9a-fA-F]+$/.test(txHash)) return report;
  return {
    ...report,
    anchors: { ...report.anchors, feedbackTx: txHash as Hex },
  };
}

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

  // Oracle leg defaults — used when `auditWorkflowOnly` is set (kh hire
  // chains an audit on the workflow's metadata, no oracle context needed
  // and no x402 settlement to oracle.zhgg.eth). The downstream code
  // already handles `settle === null` (refundable check) + `oracleResponse
  // .ok === false` (manifest stays as opts.target.manifest, line 325-330).
  let settle: Awaited<ReturnType<typeof deps.settleOraclePayment>> = null;
  let oracleResponse: OracleResponse = {
    ok: false,
    error: { kind: 'unknown_topic', topic: opts.oracleTopic },
  };

  if (!opts.auditWorkflowOnly) {
    // 1. Build payment requirements for the oracle query
    const requirements = buildPaymentRequirements({
      amount: opts.oracleAmountAtomic ?? DEFAULT_AMOUNT_ATOMIC,
      payTo: opts.feeSplitter ?? DEFAULT_SPLITTER,
      asset: opts.asset ?? DEFAULT_USDC,
      network: opts.network ?? DEFAULT_NETWORK,
      resource: {
        url: 'https://oracle-agent.zhgg/query',
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
          canonicalAuditReport: null,
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
    settle = await deps.settleOraclePayment(requirements, opts.target.agentName);
    emit('oracle.payment.settle', {
      txHash: settle?.txHash ?? null,
      network: settle?.network ?? null,
      payer: settle?.payer ?? null,
      rail: settle?.rail ?? null,
    });

    // 3. Query oracle (called directly — payment already settled)
    emit('oracle.query.start', { topic: opts.oracleTopic });
    oracleResponse = await queryOracle({ topic: opts.oracleTopic });
    emit('oracle.query.complete', { ok: oracleResponse.ok });
  }

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
  // Capture the bytes so they actually flow into BOTH (a) the Qwen
  // probe input via `manifest`, and (b) the canonical AuditReport's
  // `subjectAgent.capabilitiesAtAudit`. Pre-fix the bytes were emitted
  // for display only and Qwen audited the placeholder string —
  // structurally a probe but auditing nothing real.
  // Skipped when `auditWorkflowOnly`: workflows have no on-chain iNFT,
  // so calling AgentNFT.capabilities(0) reverts. The TUI populates
  // `subjectIdentity.capabilitiesAtAudit` with a hash of the workflow
  // metadata instead, which feeds into the canonical report below.
  let capabilitiesHex: Hex | null = null;
  if (deps.readCapabilities && !opts.auditWorkflowOnly) {
    const cap = await deps.readCapabilities(opts.target.agentId);
    emit('audit.capabilities.read', {
      ok: cap.ok,
      manifestLen: cap.manifest ? (cap.manifest.length - 2) / 2 : 0,
      error: cap.error,
    });
    if (cap.ok && cap.manifest && cap.manifest.length > 2) {
      // 0x00 happens when the iNFT was minted without capabilities;
      // skip the append so the prompt isn't littered with empty bytes
      // (Qwen tends to over-interpret tiny payloads as meaningful).
      capabilitiesHex = cap.manifest as Hex;
      manifest = `${manifest}\n\nAgent capabilities (on-chain ERC-7857, hex): ${capabilitiesHex}`;
    }
  }

  // 4.6 Step 3 — AXIOM pre-commit. The plan is the canonical intent the
  //     agent has decided to execute, derived from the enriched manifest +
  //     oracle context. Hash-only on chain; bytes revealed at Step 10.
  // Skipped when `auditWorkflowOnly`: AxiomCommit.commitPlan calls
  // AgentNFT.ownerOf(tokenId) which reverts ERC721NonexistentToken for
  // tokenId=0. Phase-2 enhancement would thread the auditor's tokenId.
  // With axiomCommit skipped, axiomCommitId stays null → reveal at the
  // bottom of this function naturally short-circuits (already conditional
  // on `axiomCommitId !== null`).
  let axiomCommitId: `0x${string}` | null = null;
  let axiomCommitTx: `0x${string}` | null = null;
  let axiomCommitBlock: bigint | null = null;
  let axiomPlanBytes: Uint8Array | null = null;
  if (deps.axiomCommit && !opts.auditWorkflowOnly) {
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
      axiomCommitTx = c.txHash ?? null;
      axiomCommitBlock = c.commitBlock ?? null;
      emit('audit.axiom.commit', { commitId: c.commitId, txHash: c.txHash, commitBlock: c.commitBlock?.toString() });
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
  let canonicalAuditReport: CanonicalAuditReport | null = null;

  // Slice Y — buildFeedbackAnchor closure runs INSIDE runAudit, after
  // probes return + verdict is known but BEFORE postReceipt is called.
  // The closure assembles the canonical AuditReport from evidence the
  // orchestrator collected on the way down (settlement, axiomCommit,
  // attestation), pins the bytes to 0G Storage, and returns the URI +
  // hash that gets recorded on chain. When storage is disabled we
  // refuse to fabricate a URI — the receipt posts with feedbackURI=""
  // + feedbackHash=0x0…0 so an indexer can prove the audit was
  // intentionally not pinned (vs. silently faking a CID).
  const buildFeedbackAnchor = async (preReceipt: {
    target: { agentId: bigint; agentName: string; manifest: string };
    verdict: 'compliant' | 'non_compliant' | 'unclear';
    findings: string[];
    results: Array<{
      id: string;
      articleRef: string;
      compliant: boolean | null;
      finding: string;
      renderedPrompt: string;
      modelId: string;
    }>;
    attestationRoot: string | null;
    teeVerified: boolean | null;
    teeProvider: string | null;
  }): Promise<{ feedbackURI: string; feedbackHash: Hex } | null> => {
    const auditor = opts.auditorIdentity;
    const subject = opts.subjectIdentity;
    const reg = opts.regulation;

    // Map verdict to ERC-8004 valueSigned (-100..+100 convention).
    const valueSigned =
      preReceipt.verdict === 'compliant'
        ? 100
        : preReceipt.verdict === 'non_compliant'
          ? -100
          : 0;

    const findings = preReceipt.results.map((r) => ({
      article: r.articleRef,
      status: findingStatus(r.compliant),
      evidence: r.finding,
    }));

    // Hash prompt = hash over the FULLY-RENDERED probe text the model
    // actually saw, joined deterministically by probe id. Pre-Commit-7 we
    // hashed `target.manifest` (just the user-supplied manifest blurb),
    // which produced identical hashes for runs whose probe templates had
    // diverged — a regulator re-running with a different ProbePrompt set
    // would compute the same `promptHash`, defeating its purpose. Joining
    // by `\n---PROBE---\n` keeps the canonical bytes language-agnostic.
    const renderedPrompts = preReceipt.results
      .map((r) => `${r.id}\n${r.renderedPrompt}`)
      .join('\n---PROBE---\n');
    const promptHash = keccak256(toBytes(renderedPrompts));
    const responseHash = keccak256(toBytes(JSON.stringify(preReceipt.results)));
    // Use the router-returned model identifier when available — falls
    // back to `'qwen3.6-plus'` so old transcripts (before Commit 7) stay
    // recognizable. Picks the FIRST non-empty modelId across probes
    // (parallel probes share router config; differences would be a bug).
    const observedModelId =
      preReceipt.results.find((r) => r.modelId.length > 0)?.modelId ?? 'qwen3.6-plus';

    const draft = buildAuditReport({
      auditorAgent: {
        iNFTAddress: auditor?.iNFTAddress ?? ZERO_ADDR,
        tokenId: (auditor?.tokenId ?? 0n).toString(),
        ens: auditor?.ens ?? 'audit-agent #1',
        manifestHash: auditor?.manifestHash ?? ZERO_HASH,
        owner: auditor?.owner ?? ZERO_ADDR,
      },
      subjectAgent: {
        tokenId: preReceipt.target.agentId.toString(),
        ens: subject?.ens,
        // Prefer the on-chain capabilities bytes captured during Step 1
        // (readCapabilities). `buildAuditReport` validates this slot
        // against `/^0x[0-9a-fA-F]+$/` — the literal `'0x'` (no payload)
        // fails the regex, so fall back to the explicit subjectIdentity
        // override or a single-byte zero placeholder when capabilities
        // weren't read on this run.
        capabilitiesAtAudit: capabilitiesHex ?? subject?.capabilitiesAtAudit ?? '0x00',
        registeredAtBlock: subject?.registeredAtBlock ?? '0',
      },
      regulation: {
        framework: reg?.framework ?? 'EU AI Act Regulation 2024/1689',
        articlesProbed: reg?.articlesProbed ?? DEFAULT_ARTICLES,
        regulatorySource: reg?.regulatorySource,
      },
      evidenceChain: {
        axiomCommit:
          axiomCommitId && axiomCommitTx
            ? {
                commitId: axiomCommitId,
                commitTx: axiomCommitTx,
                // Receipt-derived block when available (post-Commit 5
                // fix); the legacy '0' fallback is kept for the test
                // path that mocks axiomCommit without a real block.
                commitBlock: axiomCommitBlock ? axiomCommitBlock.toString() : '0',
              }
            : undefined,
        qwenInference: {
          modelId: observedModelId,
          promptHash,
          responseHash,
          // teeAttestation is the legacy raw-hex slot — only populated
          // when the attestation_root is a valid hex envelope (real
          // x-tee-attestation header path). The router's `trace.tee_verified`
          // sentinel string `'tee_verified:<provider>'` is NOT hex and
          // intentionally fails this regex; that case is captured by
          // the structured `teeVerified` + `teeProvider` fields below.
          teeAttestation:
            preReceipt.attestationRoot && /^0x[0-9a-fA-F]+$/.test(preReceipt.attestationRoot)
              ? (preReceipt.attestationRoot as Hex)
              : undefined,
          // Structured TEE evidence — `undefined` (omitted from canonical
          // bytes) when no router trace was returned. Setting to `false`
          // would imply the router rejected verification; setting to
          // `undefined` honestly says "no trace block was present."
          teeVerified:
            preReceipt.teeVerified === null ? undefined : preReceipt.teeVerified,
          teeProvider: preReceipt.teeProvider ?? undefined,
        },
        settlement:
          settle && /^0x[0-9a-fA-F]+$/.test(settle.txHash)
            ? {
                rail: settle.rail,
                tx: settle.txHash as Hex,
                amount: opts.oracleAmountAtomic ?? DEFAULT_AMOUNT_ATOMIC,
              }
            : undefined,
      },
      verdict: {
        compliant: preReceipt.verdict === 'compliant',
        findings,
        confidence:
          preReceipt.results.length === 0
            ? 0
            : preReceipt.results.filter((r) => r.compliant !== null).length /
              preReceipt.results.length,
        valueSigned,
        valueDecimals: 2,
      },
    });

    const writeResult = await writeAuditReport(draft, {
      client: deps.zgStorageClient,
      enabled: deps.zgStorageEnabled,
    });

    if (writeResult.ok) {
      canonicalAuditReport = writeResult.value.report;
      emit('audit.report.pin', {
        uri: writeResult.value.uri,
        hash: writeResult.value.hash,
        // txSeq is what storagescan's `/submission/<txSeq>` resolves
        // against. The rootHash alone has no canonical explorer page —
        // querystring-based `?root=` just opens the homepage SPA.
        txSeq: writeResult.value.txSeq,
      });
      return { feedbackURI: writeResult.value.uri, feedbackHash: writeResult.value.hash };
    }

    // Storage disabled or upload failed — keep the report but mark it
    // unpinned. ERC-8004 receipt goes out with feedbackURI="" +
    // feedbackHash=0x0…0 (an honest, indexer-greppable signal).
    canonicalAuditReport = draft;
    const err: WriteAuditReportError = writeResult.error;
    emit('audit.report.unpinned', {
      kind: err.kind,
      reason: err.reason,
    });
    return { feedbackURI: '', feedbackHash: ZERO_HASH };
  };

  try {
    auditReport = await runAudit({ ...opts.target, manifest }, deps.auditDeps, {
      ...opts.auditOptions,
      // When auditing a KH workflow (subject not in AgentRegistry), skip
      // the on-chain `giveFeedback` post — would revert AgentNotFound.
      // Storage anchor + canonical AuditReport are still produced.
      ...(opts.auditWorkflowOnly ? { skipReceiptPost: true } : {}),
      buildFeedbackAnchor,
    });
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
      // Stamp the on-chain feedbackTx onto the canonical report so
      // off-chain consumers can correlate. The bytes pinned at
      // `anchors.storageURI` already exclude this field via
      // canonicalization — mutating it here is OFF-CHAIN-ONLY and does
      // not invalidate the stored bytes' hash.
      canonicalAuditReport = stampFeedbackTx(
        canonicalAuditReport,
        auditReport.receiptTxHash
      );
    } else if (!opts.auditWorkflowOnly) {
      // Only emit receipt.failed for full runs — when auditWorkflowOnly is set,
      // skipReceiptPost:true intentionally produces receiptTxHash=null (the
      // workflow subject isn't in AgentRegistry, giveFeedback would revert).
      emit('audit.receipt.failed', { reason: auditReport.receiptError ?? 'postReceipt returned null' });
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

    // Skipped when `auditWorkflowOnly`: workflows have no on-chain iNFT,
    // so AgentNFT.updateMemoryRoot(0, ...) reverts. Phase-2 enhancement
    // would pin to the auditor's iNFT (audit.zhgg.eth = 1n) so the
    // auditor accumulates a memoryRoot history of its own audits.
    if (deps.pinMemoryRoot && storageRootHash && !opts.auditWorkflowOnly) {
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
    canonicalAuditReport,
  };
}
