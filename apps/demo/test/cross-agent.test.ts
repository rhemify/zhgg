import { describe, it, expect, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { runCrossAgentDemo } from '../src/cross-agent.js';
import type { AuditDeps } from '@zhgg/audit-agent';
import type { Erc8004Client, ZGInferenceResult, ZGRouterError, PostError, Result } from '@zhgg/workflow';

const TARGET = {
  agentId: 7n,
  agentName: 'oracle',
  manifest: 'returns regulatory feeds',
};

const okJson = (compliant: boolean, finding: string) =>
  JSON.stringify({ compliant, finding });

const okResp = (
  text: string,
  attestation: string | null = null,
  teeVerified: boolean | null = null,
  teeProvider: string | null = null
): ZGInferenceResult => ({
  response: text,
  cost_usd: 0.0006,
  latency_ms: 100,
  attestation_root: attestation,
  tee_verified: teeVerified,
  tee_provider: teeProvider,
  receipt: 'cmpl-x',
  provider_id: 'qwen3.6-plus',
  tee_verified_locally: null,
  tee_verifier_reason: null,
});

function makeAuditDeps(opts: {
  inferResponses: Array<Result<ZGInferenceResult, ZGRouterError>>;
  postResult?: Result<`0x${string}`, PostError>;
}): AuditDeps {
  let i = 0;
  const inferSpy = mock(async () => {
    const r = opts.inferResponses[i++] ?? opts.inferResponses[opts.inferResponses.length - 1];
    return r as Result<ZGInferenceResult, ZGRouterError>;
  });
  const postSpy = mock(async () =>
    opts.postResult ?? ({ ok: true, value: '0xreceipt' as `0x${string}` } as Result<`0x${string}`, PostError>)
  );
  return {
    infer: inferSpy as never,
    postReceipt: postSpy as never,
    erc8004Client: { giveFeedback: mock() } as unknown as Erc8004Client,
  };
}

describe('runCrossAgentDemo', () => {
  it('produces a complete transcript end-to-end with mocked deps', async () => {
    const settleSpy = mock(async () => ({
      txHash: '0xpaytx',
      network: 'eip155:84532',
      payer: '0xpayer',
      rail: 'direct_split' as const,
    }));

    const transcript = await runCrossAgentDemo(
      {
        settleOraclePayment: settleSpy,
        auditDeps: makeAuditDeps({
          inferResponses: [
            { ok: true, value: okResp(okJson(true, 'discloses ai'), '0xattest1') },
            { ok: true, value: okResp(okJson(true, 'no prohibited practices')) },
            { ok: true, value: okResp(okJson(true, 'discloses limits'), '0xattest3') },
          ],
        }),
      },
      {
        target: TARGET,
        oracleTopic: 'eu-ai-act',
        auditOptions: {
          apiKey: 'sk-fake',
          registryAddress: '0x1111111111111111111111111111111111111111',
          agentRegistryCaip: 'eip155:16602:0x1111111111111111111111111111111111111111',
          clientAddress: 'eip155:84532:0x2222222222222222222222222222222222222222',
          now: '2026-04-30T00:00:00Z',
        },
      }
    );

    expect(transcript.steps.length).toBeGreaterThanOrEqual(7);
    const stepNames = transcript.steps.map((s) => s.name);
    expect(stepNames).toContain('oracle.payment.request');
    expect(stepNames).toContain('oracle.payment.settle');
    expect(stepNames).toContain('oracle.query.start');
    expect(stepNames).toContain('oracle.query.complete');
    expect(stepNames).toContain('audit.start');
    expect(stepNames).toContain('audit.complete');
    expect(stepNames).toContain('audit.receipt.post');

    expect(transcript.oraclePaymentTx).toBe('0xpaytx');
    expect(transcript.auditReceiptTx).toBe('0xreceipt');
    expect(transcript.auditReport?.verdict).toBe('compliant');
    expect(transcript.totalCostUSD).toBeCloseTo(0.1 + 3 * 0.0006, 4);
  });

  it('emits step events on the supplied EventEmitter for the TUI', async () => {
    const events = new EventEmitter();
    const seen: string[] = [];
    events.on('oracle.payment.request', () => seen.push('oracle.payment.request'));
    events.on('audit.complete', () => seen.push('audit.complete'));

    await runCrossAgentDemo(
      {
        settleOraclePayment: async () => null,
        auditDeps: makeAuditDeps({
          inferResponses: [
            { ok: true, value: okResp(okJson(true, 'ok')) },
            { ok: true, value: okResp(okJson(true, 'ok')) },
            { ok: true, value: okResp(okJson(true, 'ok')) },
          ],
        }),
      },
      {
        target: TARGET,
        oracleTopic: 'eu-ai-act',
        auditOptions: {
          apiKey: 'sk-fake',
          registryAddress: '0x1111111111111111111111111111111111111111',
          agentRegistryCaip: 'eip155:16602:0x1111111111111111111111111111111111111111',
          clientAddress: 'eip155:84532:0x2222222222222222222222222222222222222222',
        },
        events,
      }
    );

    expect(seen).toContain('oracle.payment.request');
    expect(seen).toContain('audit.complete');
  });

  it('settle returning null is handled (dry-run mode)', async () => {
    const transcript = await runCrossAgentDemo(
      {
        settleOraclePayment: async () => null,
        auditDeps: makeAuditDeps({
          inferResponses: [
            { ok: true, value: okResp(okJson(true, 'ok')) },
            { ok: true, value: okResp(okJson(true, 'ok')) },
            { ok: true, value: okResp(okJson(true, 'ok')) },
          ],
        }),
      },
      {
        target: TARGET,
        oracleTopic: 'eu-ai-act',
        auditOptions: {
          apiKey: 'sk-fake',
          registryAddress: '0x1111111111111111111111111111111111111111',
          agentRegistryCaip: 'eip155:16602:0x1111111111111111111111111111111111111111',
          clientAddress: 'eip155:84532:0x2222222222222222222222222222222222222222',
        },
      }
    );
    expect(transcript.oraclePaymentTx).toBeNull();
    expect(transcript.auditReport?.verdict).toBe('compliant');
  });

  it('settle succeeded + audit threw → emits audit.failed and flags refundable', async () => {
    const inferThrows: AuditDeps = {
      infer: (async () => {
        throw new Error('inference adapter exploded');
      }) as never,
      postReceipt: (async () => ({
        ok: true,
        value: '0x' as `0x${string}`,
      })) as never,
      erc8004Client: { giveFeedback: mock() } as unknown as Erc8004Client,
    };

    const transcript = await runCrossAgentDemo(
      {
        settleOraclePayment: async () => ({
          txHash: '0xpaid',
          network: 'eip155:84532',
          payer: '0xp',
          rail: 'direct_split',
        }),
        auditDeps: inferThrows,
      },
      {
        target: TARGET,
        oracleTopic: 'eu-ai-act',
        auditOptions: {
          apiKey: 'sk-fake',
          registryAddress: '0x1111111111111111111111111111111111111111',
          agentRegistryCaip: 'eip155:16602:0x1111111111111111111111111111111111111111',
          clientAddress: 'eip155:84532:0x2222222222222222222222222222222222222222',
        },
      }
    );

    const stepNames = transcript.steps.map((s) => s.name);
    expect(stepNames).toContain('audit.failed');
    expect(transcript.auditReport).toBeNull();
    expect(transcript.auditReceiptTx).toBeNull();
    expect(transcript.oraclePaymentTx).toBe('0xpaid'); // user paid
    expect(transcript.refundable).toBe(true);
    expect(transcript.auditError).toContain('exploded');
  });

  it('non_compliant verdict propagates through transcript', async () => {
    const transcript = await runCrossAgentDemo(
      {
        settleOraclePayment: async () => ({
          txHash: '0xpay',
          network: 'eip155:84532',
          payer: '0xp',
          rail: 'direct_split',
        }),
        auditDeps: makeAuditDeps({
          inferResponses: [
            { ok: true, value: okResp(okJson(true, 'ok')) },
            { ok: true, value: okResp(okJson(false, 'biometric scoring detected')) },
            { ok: true, value: okResp(okJson(true, 'ok')) },
          ],
        }),
      },
      {
        target: TARGET,
        oracleTopic: 'eu-ai-act',
        auditOptions: {
          apiKey: 'sk-fake',
          registryAddress: '0x1111111111111111111111111111111111111111',
          agentRegistryCaip: 'eip155:16602:0x1111111111111111111111111111111111111111',
          clientAddress: 'eip155:84532:0x2222222222222222222222222222222222222222',
        },
      }
    );
    expect(transcript.auditReport?.verdict).toBe('non_compliant');
    const completeStep = transcript.steps.find((s) => s.name === 'audit.complete');
    expect(completeStep?.detail?.verdict).toBe('non_compliant');
  });

  /// Commit 6 — structured TEE evidence flows from inferZG router-trace
  /// fields through audit-agent into the canonical AuditReport. Pre-fix,
  /// only the legacy `attestation_root` sentinel string crossed the
  /// boundary; the router's `trace.tee_verified` boolean was lost in the
  /// /^0x[0-9a-fA-F]+$/ regex check on the cross-agent side. Now the
  /// structured fields ride alongside, omitted (not zeroed) when the
  /// router didn't return a trace block.
  it('threads structured TEE verdict (teeVerified + teeProvider) into canonical AuditReport', async () => {
    const teeOk: ZGInferenceResult = {
      response: okJson(true, 'discloses ai'),
      cost_usd: 0.0006,
      latency_ms: 100,
      attestation_root: 'tee_verified:qwen-tee-1',
      tee_verified: true,
      tee_provider: 'qwen-tee-1',
      receipt: 'cmpl-tee-1',
      provider_id: 'qwen3.6-plus',
      tee_verified_locally: null,
      tee_verifier_reason: null,
    };
    const transcript = await runCrossAgentDemo(
      {
        settleOraclePayment: async () => null,
        auditDeps: makeAuditDeps({
          inferResponses: [
            { ok: true, value: teeOk },
            { ok: true, value: teeOk },
            { ok: true, value: teeOk },
          ],
        }),
      },
      {
        target: TARGET,
        oracleTopic: 'eu-ai-act',
        auditOptions: {
          apiKey: 'sk-fake',
          registryAddress: '0x1111111111111111111111111111111111111111',
          agentRegistryCaip: 'eip155:16602:0x1111111111111111111111111111111111111111',
          clientAddress: 'eip155:84532:0x2222222222222222222222222222222222222222',
        },
      }
    );
    const qwen = transcript.canonicalAuditReport?.evidenceChain?.qwenInference;
    expect(qwen).toBeTruthy();
    expect(qwen?.teeVerified).toBe(true);
    expect(qwen?.teeProvider).toBe('qwen-tee-1');
    // Legacy slot stays absent because the sentinel string isn't valid hex.
    expect(qwen?.teeAttestation).toBeUndefined();
  });

  it('omits teeVerified entirely when router returned no trace (honest unknown)', async () => {
    // Default `okResp` helper sets tee_verified + tee_provider to null —
    // matches the "no trace block" path. Canonical bytes must omit both
    // fields rather than emit `false` / empty string, so a regulator can
    // distinguish "router rejected" (false) from "no trace" (omitted).
    const transcript = await runCrossAgentDemo(
      {
        settleOraclePayment: async () => null,
        auditDeps: makeAuditDeps({
          inferResponses: [
            { ok: true, value: okResp(okJson(true, 'a')) },
            { ok: true, value: okResp(okJson(true, 'b')) },
            { ok: true, value: okResp(okJson(true, 'c')) },
          ],
        }),
      },
      {
        target: TARGET,
        oracleTopic: 'eu-ai-act',
        auditOptions: {
          apiKey: 'sk-fake',
          registryAddress: '0x1111111111111111111111111111111111111111',
          agentRegistryCaip: 'eip155:16602:0x1111111111111111111111111111111111111111',
          clientAddress: 'eip155:84532:0x2222222222222222222222222222222222222222',
        },
      }
    );
    const qwen = transcript.canonicalAuditReport?.evidenceChain?.qwenInference;
    expect(qwen?.teeVerified).toBeUndefined();
    expect(qwen?.teeProvider).toBeUndefined();
  });

  /// Commit 7 — modelId comes from the router's actual `provider_id`,
  /// promptHash comes from the FULLY-RENDERED probe text the model saw.
  /// Pre-fix, modelId was hardcoded `'qwen3.6-plus'` and promptHash
  /// hashed the un-rendered manifest. A regulator re-running with a
  /// different ProbePrompt set would compute the same `promptHash` even
  /// though the actual model input was different — defeating the hash.
  it('records router-actual modelId + rendered-prompt promptHash in canonical report', async () => {
    const customResp = (model: string): ZGInferenceResult => ({
      response: okJson(true, 'ok'),
      cost_usd: 0.0006,
      latency_ms: 100,
      attestation_root: null,
      tee_verified: null,
      tee_provider: null,
      receipt: 'cmpl-x',
      provider_id: model,
      tee_verified_locally: null,
      tee_verifier_reason: null,
    });
    const target1 = { ...TARGET, manifest: 'first manifest' };
    const target2 = { ...TARGET, manifest: 'second manifest' };
    const ROUTER_MODEL = 'qwen3.6-plus-tee-2025-04';
    const auditOpts = {
      apiKey: 'sk-fake',
      registryAddress: '0x1111111111111111111111111111111111111111' as `0x${string}`,
      agentRegistryCaip: 'eip155:16602:0x1111111111111111111111111111111111111111' as const,
      clientAddress: 'eip155:84532:0x2222222222222222222222222222222222222222' as const,
    };

    const t1 = await runCrossAgentDemo(
      {
        settleOraclePayment: async () => null,
        auditDeps: makeAuditDeps({
          inferResponses: [
            { ok: true, value: customResp(ROUTER_MODEL) },
            { ok: true, value: customResp(ROUTER_MODEL) },
            { ok: true, value: customResp(ROUTER_MODEL) },
          ],
        }),
      },
      { target: target1, oracleTopic: 'eu-ai-act', auditOptions: auditOpts }
    );
    const t2 = await runCrossAgentDemo(
      {
        settleOraclePayment: async () => null,
        auditDeps: makeAuditDeps({
          inferResponses: [
            { ok: true, value: customResp(ROUTER_MODEL) },
            { ok: true, value: customResp(ROUTER_MODEL) },
            { ok: true, value: customResp(ROUTER_MODEL) },
          ],
        }),
      },
      { target: target2, oracleTopic: 'eu-ai-act', auditOptions: auditOpts }
    );

    const qwen1 = t1.canonicalAuditReport?.evidenceChain?.qwenInference;
    const qwen2 = t2.canonicalAuditReport?.evidenceChain?.qwenInference;
    expect(qwen1?.modelId).toBe(ROUTER_MODEL);
    expect(qwen2?.modelId).toBe(ROUTER_MODEL);
    // Different manifest → different rendered prompts → different hash.
    // Pre-Commit-7, both runs would compute the same promptHash because
    // we hashed the manifest, not the rendered prompts.
    expect(qwen1?.promptHash).not.toBe(qwen2?.promptHash);
  });

  /// Plan 2025-05-03 — `auditWorkflowOnly` mode for `kh hire` auto-chain.
  /// Audits a KH workflow (no iNFT, no AgentRegistry entry) by skipping
  /// the iNFT-coupled steps (oracle payment/query, capabilities-read,
  /// AxiomCommit, memoryRoot pin, giveFeedback) while still running
  /// Qwen probes + 0G Storage anchor + canonical AuditReport. The
  /// storage URI is the regulator-readable proof.
  it('auditWorkflowOnly skips oracle/capabilities/axiom/memory; keeps probes + storage anchor', async () => {
    const settleSpy = mock(async () => ({
      txHash: '0xshouldnotbecalled' as `0x${string}`,
      network: 'eip155:84532',
      payer: '0xnope' as `0x${string}`,
      rail: 'direct_split' as const,
    }));
    const readCapsSpy = mock(async () => ({ ok: true as const, manifest: '0xdead' }));
    const axiomCommitSpy = mock(async () => ({ ok: true as const, commitId: '0xCC' as `0x${string}`, txHash: '0xTX' as `0x${string}`, commitBlock: 1n }));
    const axiomRevealSpy = mock(async () => ({ ok: true as const, txHash: '0xRV' as `0x${string}` }));
    const pinMemorySpy = mock(async () => ({ ok: true as const, txHash: '0xPIN' as `0x${string}` }));
    // Spy on auditDeps.postReceipt to confirm skipReceiptPost flowed through.
    const auditDeps = makeAuditDeps({
      inferResponses: [
        { ok: true, value: okResp(okJson(true, 'a')) },
        { ok: true, value: okResp(okJson(true, 'b')) },
        { ok: true, value: okResp(okJson(true, 'c')) },
      ],
    });
    const postReceiptOriginal = auditDeps.postReceipt;
    const postReceiptSpy = mock(postReceiptOriginal as never);
    auditDeps.postReceipt = postReceiptSpy as never;

    const transcript = await runCrossAgentDemo(
      {
        settleOraclePayment: settleSpy,
        readCapabilities: readCapsSpy as never,
        axiomCommit: axiomCommitSpy as never,
        axiomReveal: axiomRevealSpy as never,
        pinMemoryRoot: pinMemorySpy as never,
        auditDeps,
      },
      {
        target: {
          agentId: 0n,
          registryAgentId: 0n,
          agentName: 'kh:test/some-workflow',
          manifest: 'name: workflow X; description: does Y',
        },
        oracleTopic: 'eu-ai-act',
        auditOptions: {
          apiKey: 'sk-fake',
          registryAddress: '0x1111111111111111111111111111111111111111',
          agentRegistryCaip: 'eip155:16602:0x1111111111111111111111111111111111111111',
          clientAddress: 'eip155:84532:0x2222222222222222222222222222222222222222',
        },
        auditWorkflowOnly: true,
      }
    );

    // Skip-list: none of these iNFT-coupled steps fire.
    expect(settleSpy).not.toHaveBeenCalled();
    expect(readCapsSpy).not.toHaveBeenCalled();
    expect(axiomCommitSpy).not.toHaveBeenCalled();
    expect(axiomRevealSpy).not.toHaveBeenCalled();
    expect(pinMemorySpy).not.toHaveBeenCalled();
    expect(postReceiptSpy).not.toHaveBeenCalled();
    // No oracle.payment.* events emitted either.
    const stepNames = transcript.steps.map((s) => s.name);
    expect(stepNames).not.toContain('oracle.payment.request');
    expect(stepNames).not.toContain('oracle.payment.settle');
    expect(stepNames).not.toContain('oracle.query.start');
    expect(stepNames).not.toContain('audit.capabilities.read');
    expect(stepNames).not.toContain('audit.axiom.commit');
    expect(stepNames).not.toContain('audit.memory_root.pin');

    // Keep-list: probes ran, audit completed, canonical report exists.
    // (audit.start/audit.complete fire from runCrossAgentDemo, audit.report.*
    // fires from buildFeedbackAnchor — both expected in workflow mode.)
    expect(stepNames).toContain('audit.start');
    expect(stepNames).toContain('audit.complete');
    expect(transcript.auditReport?.verdict).toBe('compliant');
    expect(transcript.auditReport?.results.length).toBe(3); // 3 probes
  });
});
