import { describe, it, expect, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { runCrossAgentDemo } from '../src/cross-agent.js';
import type { AuditDeps } from '@zhgg/audit-agent';
import type { Erc8004Client, ZGInferenceResult, ZGRouterError, PostError, Result } from '@zhgg/workflow';

const TARGET = {
  agentId: 7n,
  agentName: 'oracle.zhgg.eth',
  manifest: 'returns regulatory feeds',
};

const okJson = (compliant: boolean, finding: string) =>
  JSON.stringify({ compliant, finding });

const okResp = (text: string, attestation: string | null = null): ZGInferenceResult => ({
  response: text,
  cost_usd: 0.0006,
  latency_ms: 100,
  attestation_root: attestation,
  receipt: 'cmpl-x',
  provider_id: 'qwen3.6-plus',
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
});
