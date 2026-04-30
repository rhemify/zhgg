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
  agentId: bigint;
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
}

export async function runAudit(
  target: AuditTarget,
  deps: AuditDeps,
  opts: AuditOptions
): Promise<AuditReport> {
  const results: ProbeResult[] = [];
  let lastAttestation: string | null = null;

  for (const probe of PROBE_PROMPTS) {
    const prompt = renderProbe(probe, target.manifest);
    const inference = await deps.infer(prompt, { apiKey: opts.apiKey });

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

  const receiptCtx: ReceiptContext = {
    registryAddress: opts.registryAddress,
    agentRegistryCaip: opts.agentRegistryCaip,
    agentId: target.agentId,
    clientAddress: opts.clientAddress,
    value,
    valueDecimals: 0,
    tag1,
    tag2,
    endpoint: 'https://audit.zhgg.eth/v1',
    feedbackURI: `ipfs://placeholder/${target.agentName}`,
    attestationRoot: lastAttestation,
    paymentTxHash: null,
    createdAt: opts.now ?? new Date().toISOString(),
  };

  const post = await deps.postReceipt(deps.erc8004Client, receiptCtx);
  const receiptTxHash = post.ok ? post.value : null;

  return {
    target: { agentId: target.agentId, agentName: target.agentName },
    verdict,
    results,
    findings,
    attestationRoot: lastAttestation,
    receiptTxHash,
  };
}
