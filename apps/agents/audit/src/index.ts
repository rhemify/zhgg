/// audit.zhgg.eth — EU AI Act compliance auditor.
///
/// Runs each probe through 0G Compute TEE, parses the structured response,
/// aggregates a verdict, and posts the result to ERC-8004's Reputation
/// Registry. All external dependencies (inference, on-chain post) are
/// injected so the agent module is testable without network or chain.

import type {
  Erc8004Client,
  PostError,
  ReceiptContext,
  Result,
  ZGInferenceResult,
  ZGRouterError,
} from '@zhgg/workflow';
import {
  PROBE_PROMPTS,
  aggregateFindings,
  aggregateVerdict,
  parseProbeResponse,
  renderProbe,
  type AuditReport,
  type ProbeResult,
  type Quorum,
  type Verdict,
} from './audit-core.js';

export type {
  AuditReport,
  ProbeResult,
  Quorum,
  Verdict,
  ProbePrompt,
} from './audit-core.js';
export { PROBE_PROMPTS, aggregateVerdict, parseProbeResponse } from './audit-core.js';

export interface AuditTarget {
  /// AgentNFT (ERC-7857) iNFT tokenId. Used by AxiomCommit,
  /// readCapabilities, memoryRoot pin, and the canonical AuditReport's
  /// `subjectAgent.tokenId`. NOT the same as `registryAgentId` —
  /// AgentRegistry is its own ERC-721 with its own counter.
  agentId: bigint;
  /// AgentRegistry (ERC-8004) agentId. Used ONLY for `giveFeedback`.
  /// When omitted, falls back to `agentId` for backward compatibility
  /// (works when both contracts happen to share the same numbering,
  /// which is the case for the current zhgg deployment).
  registryAgentId?: bigint;
  agentName: string;
  /// Free-form manifest of the target's capabilities — fed into each probe
  /// prompt. In practice, this is the target's ERC-7857 capability blob.
  manifest: string;
}

export interface AuditDeps {
  infer: (
    prompt: string,
    opts: { apiKey: string }
  ) => Promise<Result<ZGInferenceResult, ZGRouterError>>;
  postReceipt: (
    client: Erc8004Client,
    ctx: ReceiptContext
  ) => Promise<Result<`0x${string}`, PostError>>;
  erc8004Client: Erc8004Client;
}

export interface AuditOptions {
  apiKey: string;
  registryAddress: `0x${string}`;
  agentRegistryCaip: string;
  clientAddress: string;
  /// ISO-8601 timestamp for the receipt's `createdAt` field. Defaults to
  /// `new Date().toISOString()` — accept an override for deterministic
  /// tests.
  now?: string;
  /// Verdict aggregation policy. `'all'` is strict (default); `'majority'`
  /// is demo-robust — one flaky probe doesn't drag the whole verdict.
  quorum?: Quorum;
  /// Optional callback fired AFTER probes complete + verdict is known but
  /// BEFORE postReceipt is called. Lets the orchestrator build an
  /// AuditReport (Slice Y), pin the canonical bytes to 0G Storage, and
  /// return the real `feedbackURI` + `feedbackHash` to be recorded
  /// on chain. When omitted, runAudit falls back to `zhgg://placeholder/...`
  /// + a hash of the placeholder URI — a clearly-marked unpinned receipt.
  buildFeedbackAnchor?: (preReceipt: {
    target: AuditTarget;
    verdict: Verdict;
    findings: string[];
    results: ProbeResult[];
    attestationRoot: string | null;
    /// Structured TEE verdict from the router (Phase 23). `null` when no
    /// router trace was returned; never silently `false` for a missing
    /// trace. Threaded so the canonical AuditReport can record evidence
    /// honestly — see `evidenceChain.qwenInference.teeVerified`.
    teeVerified: boolean | null;
    /// Provider name from the router trace (e.g. `'qwen-tee-1'`). Null
    /// when no trace.
    teeProvider: string | null;
  }) => Promise<{ feedbackURI: string; feedbackHash: `0x${string}` } | null>;
}

export async function runAudit(
  target: AuditTarget,
  deps: AuditDeps,
  opts: AuditOptions
): Promise<AuditReport> {
  // Probes are independent — fire them all in parallel and process the
  // results in deterministic PROBE_PROMPTS order. `Promise.all` preserves
  // input order in its output array, so `lastAttestation` stays stable
  // across runs and the receipt's attestation root is reproducible.
  const inferences = await Promise.all(
    PROBE_PROMPTS.map((probe) => {
      const prompt = renderProbe(probe, target.manifest);
      return deps
        .infer(prompt, { apiKey: opts.apiKey })
        .then((inference) => ({ probe, inference } as const));
    })
  );

  const results: ProbeResult[] = [];
  let lastAttestation: string | null = null;
  // Structured TEE evidence — tracked alongside `lastAttestation`. We
  // record the most recent non-null verdict because all probes share the
  // same router config; if any probe surfaced a structured trace, that
  // trace describes the inference pipeline used for the audit. Honest
  // "unknown" vs. silently-false: starts as `null` and only flips when a
  // probe explicitly returns a value.
  let lastTeeVerified: boolean | null = null;
  let lastTeeProvider: string | null = null;

  for (const { probe, inference } of inferences) {
    if (!inference.ok) {
      results.push({
        id: probe.id,
        articleRef: probe.articleRef,
        compliant: null,
        finding: `inference failed (${inference.error.kind}): ${inference.error.reason}`,
      });
      continue;
    }

    if (inference.value.attestation_root) {
      lastAttestation = inference.value.attestation_root;
    }
    if (inference.value.tee_verified !== null) {
      lastTeeVerified = inference.value.tee_verified;
    }
    if (inference.value.tee_provider !== null) {
      lastTeeProvider = inference.value.tee_provider;
    }

    const parsed = parseProbeResponse(inference.value.response);
    if (parsed === null) {
      results.push({
        id: probe.id,
        articleRef: probe.articleRef,
        compliant: null,
        finding: `model returned non-JSON response`,
      });
      continue;
    }

    results.push({
      id: probe.id,
      articleRef: probe.articleRef,
      compliant: parsed.compliant,
      finding: parsed.finding,
    });
  }

  const verdict: Verdict = aggregateVerdict(results, { quorum: opts.quorum });
  const findings = aggregateFindings(results);

  // Post the audit receipt regardless of verdict — even non-compliant or
  // unclear results are valuable signal for reputation aggregators.
  const tag1 = 'audit';
  const tag2 = `eu-ai-act:${verdict}`;
  // value: 100 for compliant, 0 for non-compliant, 50 for unclear
  const value = verdict === 'compliant' ? 100 : verdict === 'non_compliant' ? 0 : 50;

  // Slice Y — let the orchestrator build a tamper-proof AuditReport,
  // pin it to 0G Storage, and supply the real feedbackURI + hash. When
  // the callback is absent OR returns null (storage disabled, no client),
  // we fall through with a clearly-marked `zhgg://placeholder/...` URI
  // so anyone indexing 8004 receipts can grep for unpinned audits.
  let anchor: { feedbackURI: string; feedbackHash: `0x${string}` } | null = null;
  if (opts.buildFeedbackAnchor) {
    anchor = await opts.buildFeedbackAnchor({
      target,
      verdict,
      findings,
      results,
      attestationRoot: lastAttestation,
      teeVerified: lastTeeVerified,
      teeProvider: lastTeeProvider,
    });
  }

  const receiptCtx: ReceiptContext = {
    registryAddress: opts.registryAddress,
    agentRegistryCaip: opts.agentRegistryCaip,
    // ERC-8004 giveFeedback expects the AgentRegistry's own agentId,
    // not the AgentNFT iNFT tokenId. Fall back to target.agentId
    // (matches old behavior + works when both ids align).
    agentId: target.registryAgentId ?? target.agentId,
    clientAddress: opts.clientAddress,
    value,
    valueDecimals: 0,
    tag1,
    tag2,
    endpoint: 'https://audit.zhgg.eth/v1',
    feedbackURI: anchor?.feedbackURI ?? `zhgg://placeholder/audit/${target.agentName}`,
    attestationRoot: lastAttestation,
    paymentTxHash: null,
    createdAt: opts.now ?? new Date().toISOString(),
    feedbackHashOverride: anchor?.feedbackHash,
  };

  const post = await deps.postReceipt(deps.erc8004Client, receiptCtx);
  const receiptTxHash = post.ok ? post.value : null;
  const receiptError = post.ok ? undefined : `${post.error.kind}: ${post.error.reason}`;

  return {
    target: { agentId: target.agentId, agentName: target.agentName },
    verdict,
    results,
    findings,
    attestationRoot: lastAttestation,
    teeVerified: lastTeeVerified,
    teeProvider: lastTeeProvider,
    receiptTxHash,
    receiptError,
  };
}
