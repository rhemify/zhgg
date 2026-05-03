import { describe, it, expect, mock } from 'bun:test';
import {
  runAudit,
  parseProbeResponse,
  aggregateVerdict,
  PROBE_PROMPTS,
  type AuditDeps,
  type AuditTarget,
  type AuditOptions,
} from '../src/index.js';
import type {
  Erc8004Client,
  ZGInferenceResult,
  ZGRouterError,
  PostError,
  Result,
} from '@zhgg/workflow';

const TARGET: AuditTarget = {
  agentId: 7n,
  agentName: 'oracle.zhgg.eth',
  manifest: 'Returns regulatory feeds and prices via MCP query tool',
};

const OPTS: AuditOptions = {
  apiKey: 'sk-fake',
  registryAddress: '0x1111111111111111111111111111111111111111',
  agentRegistryCaip: 'eip155:16602:0x1111111111111111111111111111111111111111',
  clientAddress: 'eip155:84532:0x2222222222222222222222222222222222222222',
  now: '2026-04-30T00:00:00Z',
};

const okResp = (text: string, attestation: string | null = null): ZGInferenceResult => ({
  response: text,
  cost_usd: 0.0006,
  latency_ms: 100,
  attestation_root: attestation,
  tee_verified: null,
  tee_provider: null,
  receipt: 'cmpl-x',
  provider_id: 'qwen3.6-plus',
  tee_verified_locally: null,
  tee_verifier_reason: null,
});

const okJson = (compliant: boolean, finding: string) =>
  JSON.stringify({ compliant, finding });

function makeDeps(opts: {
  inferResponses: Array<Result<ZGInferenceResult, ZGRouterError>>;
  postResult?: Result<`0x${string}`, PostError>;
}): { deps: AuditDeps; spy: ReturnType<typeof mock> } {
  let i = 0;
  const inferSpy = mock(async () => {
    const r = opts.inferResponses[i++] ?? opts.inferResponses[opts.inferResponses.length - 1];
    return r as Result<ZGInferenceResult, ZGRouterError>;
  });
  const postSpy = mock(async () =>
    opts.postResult ?? ({ ok: true, value: '0xreceipt' as `0x${string}` } as Result<`0x${string}`, PostError>)
  );
  const deps: AuditDeps = {
    infer: inferSpy as never,
    postReceipt: postSpy as never,
    erc8004Client: { giveFeedback: mock() } as unknown as Erc8004Client,
  };
  return { deps, spy: inferSpy };
}

describe('parseProbeResponse', () => {
  it('parses well-formed JSON', () => {
    const out = parseProbeResponse('{"compliant": true, "finding": "ok"}');
    expect(out).toEqual({ compliant: true, finding: 'ok' });
  });

  it('strips markdown code fences', () => {
    const out = parseProbeResponse('```json\n{"compliant": false, "finding": "bad"}\n```');
    expect(out).toEqual({ compliant: false, finding: 'bad' });
  });

  it('returns null on malformed JSON', () => {
    expect(parseProbeResponse('not json at all')).toBeNull();
    expect(parseProbeResponse('{"missing": "fields"}')).toBeNull();
    expect(parseProbeResponse('{"compliant": "yes", "finding": ""}')).toBeNull();
  });
});

describe('aggregateVerdict', () => {
  it('all compliant → compliant', () => {
    const r = PROBE_PROMPTS.map((p) => ({
      id: p.id,
      articleRef: p.articleRef,
      compliant: true,
      finding: 'ok',
      renderedPrompt: '',
      modelId: '',
    }));
    expect(aggregateVerdict(r)).toBe('compliant');
  });

  it('any non-compliant → non_compliant', () => {
    expect(
      aggregateVerdict([
        { id: 'a', articleRef: 'A', compliant: true, finding: '', renderedPrompt: '', modelId: '' },
        { id: 'b', articleRef: 'B', compliant: false, finding: '', renderedPrompt: '', modelId: '' },
        { id: 'c', articleRef: 'C', compliant: true, finding: '', renderedPrompt: '', modelId: '' },
      ])
    ).toBe('non_compliant');
  });

  it('clean except null → unclear', () => {
    expect(
      aggregateVerdict([
        { id: 'a', articleRef: 'A', compliant: true, finding: '', renderedPrompt: '', modelId: '' },
        { id: 'b', articleRef: 'B', compliant: null, finding: '', renderedPrompt: '', modelId: '' },
      ])
    ).toBe('unclear');
  });

  it('empty → unclear', () => {
    expect(aggregateVerdict([])).toBe('unclear');
  });

  it('majority quorum: 2/3 compliant → compliant', () => {
    const r = [
      { id: 'a', articleRef: 'A', compliant: true, finding: '', renderedPrompt: '', modelId: '' },
      { id: 'b', articleRef: 'B', compliant: false, finding: '', renderedPrompt: '', modelId: '' },
      { id: 'c', articleRef: 'C', compliant: true, finding: '', renderedPrompt: '', modelId: '' },
    ];
    expect(aggregateVerdict(r, { quorum: 'majority' })).toBe('compliant');
    expect(aggregateVerdict(r, { quorum: 'all' })).toBe('non_compliant');
  });

  it('majority quorum: 2/3 non_compliant → non_compliant', () => {
    const r = [
      { id: 'a', articleRef: 'A', compliant: false, finding: '', renderedPrompt: '', modelId: '' },
      { id: 'b', articleRef: 'B', compliant: false, finding: '', renderedPrompt: '', modelId: '' },
      { id: 'c', articleRef: 'C', compliant: true, finding: '', renderedPrompt: '', modelId: '' },
    ];
    expect(aggregateVerdict(r, { quorum: 'majority' })).toBe('non_compliant');
  });

  it('majority quorum: 1/3 each way + 1 unclear → unclear (no majority)', () => {
    const r = [
      { id: 'a', articleRef: 'A', compliant: true, finding: '', renderedPrompt: '', modelId: '' },
      { id: 'b', articleRef: 'B', compliant: false, finding: '', renderedPrompt: '', modelId: '' },
      { id: 'c', articleRef: 'C', compliant: null, finding: '', renderedPrompt: '', modelId: '' },
    ];
    expect(aggregateVerdict(r, { quorum: 'majority' })).toBe('unclear');
  });
});

describe('runAudit', () => {
  it('happy path: 3/3 compliant → verdict compliant + receipt posted', async () => {
    const { deps } = makeDeps({
      inferResponses: [
        { ok: true, value: okResp(okJson(true, 'discloses ai'), '0xattest1') },
        { ok: true, value: okResp(okJson(true, 'no prohibited practices')) },
        { ok: true, value: okResp(okJson(true, 'discloses limits'), '0xattest3') },
      ],
    });

    const report = await runAudit(TARGET, deps, OPTS);
    expect(report.verdict).toBe('compliant');
    expect(report.results).toHaveLength(3);
    expect(report.results.every((r) => r.compliant === true)).toBe(true);
    expect(report.attestationRoot).toBe('0xattest3'); // last attestation kept
    expect(report.receiptTxHash).toBe('0xreceipt');
    expect(report.findings).toHaveLength(3);
  });

  it('mixed: 1 non-compliant → verdict non_compliant', async () => {
    const { deps } = makeDeps({
      inferResponses: [
        { ok: true, value: okResp(okJson(true, 'ok')) },
        { ok: true, value: okResp(okJson(false, 'biometric scoring detected')) },
        { ok: true, value: okResp(okJson(true, 'ok')) },
      ],
    });
    const report = await runAudit(TARGET, deps, OPTS);
    expect(report.verdict).toBe('non_compliant');
    expect(report.findings.some((f) => f.includes('biometric'))).toBe(true);
  });

  it('inference fails on one probe → that probe is unclear, verdict unclear', async () => {
    const { deps } = makeDeps({
      inferResponses: [
        { ok: true, value: okResp(okJson(true, 'ok')) },
        { ok: false, error: { kind: 'transport', reason: 'timeout' } },
        { ok: true, value: okResp(okJson(true, 'ok')) },
      ],
    });
    const report = await runAudit(TARGET, deps, OPTS);
    expect(report.verdict).toBe('unclear');
    expect(report.results[1]!.compliant).toBeNull();
    expect(report.results[1]!.finding).toContain('inference failed');
  });

  it('malformed JSON response counted as unclear for that probe', async () => {
    const { deps } = makeDeps({
      inferResponses: [
        { ok: true, value: okResp('not actually json') },
        { ok: true, value: okResp(okJson(true, 'ok')) },
        { ok: true, value: okResp(okJson(true, 'ok')) },
      ],
    });
    const report = await runAudit(TARGET, deps, OPTS);
    expect(report.verdict).toBe('unclear');
    expect(report.results[0]!.compliant).toBeNull();
    expect(report.results[0]!.finding).toContain('non-JSON');
  });

  it('postReceipt failure: report still produced with receiptTxHash=null', async () => {
    const { deps } = makeDeps({
      inferResponses: [
        { ok: true, value: okResp(okJson(true, 'ok')) },
        { ok: true, value: okResp(okJson(true, 'ok')) },
        { ok: true, value: okResp(okJson(true, 'ok')) },
      ],
      postResult: { ok: false, error: { kind: 'post_failed', reason: 'rpc down' } },
    });
    const report = await runAudit(TARGET, deps, OPTS);
    expect(report.verdict).toBe('compliant');
    expect(report.receiptTxHash).toBeNull();
  });
});
