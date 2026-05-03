/// `runAudit` integration coverage for areas not exercised by
/// `audit.test.ts` — call ordering of `buildFeedbackAnchor` vs
/// `postReceipt`, anchor URI/hash propagation, placeholder fallback,
/// and the receipt `value` field across each verdict bucket.

import { describe, it, expect, mock } from 'bun:test';
import { runAudit, type AuditDeps, type AuditTarget, type AuditOptions } from '../src/index.js';
import type {
  Erc8004Client,
  PostError,
  ReceiptContext,
  Result,
  ZGInferenceResult,
  ZGRouterError,
} from '@zhgg/workflow';

const TARGET: AuditTarget = {
  agentId: 42n,
  agentName: 'oracle.zhgg.eth',
  manifest: 'returns price feeds and regulatory data via MCP',
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

interface DepsBundle {
  deps: AuditDeps;
  inferSpy: ReturnType<typeof mock>;
  postSpy: ReturnType<typeof mock>;
  postedCtx: { value?: ReceiptContext };
}

function makeDeps(opts: {
  inferResponses: Array<Result<ZGInferenceResult, ZGRouterError>>;
  postResult?: Result<`0x${string}`, PostError>;
}): DepsBundle {
  let i = 0;
  const inferSpy = mock(async () => {
    const r = opts.inferResponses[i++] ?? opts.inferResponses[opts.inferResponses.length - 1];
    return r as Result<ZGInferenceResult, ZGRouterError>;
  });
  const postedCtx: { value?: ReceiptContext } = {};
  const postSpy = mock(async (_client: Erc8004Client, ctx: ReceiptContext) => {
    postedCtx.value = ctx;
    return (
      opts.postResult ??
      ({ ok: true, value: '0xreceipt' as `0x${string}` } as Result<`0x${string}`, PostError>)
    );
  });
  const deps: AuditDeps = {
    infer: inferSpy as never,
    postReceipt: postSpy as never,
    erc8004Client: { giveFeedback: mock() } as unknown as Erc8004Client,
  };
  return { deps, inferSpy, postSpy, postedCtx };
}

describe('runAudit — buildFeedbackAnchor callback', () => {
  it('fires AFTER all probes complete and BEFORE postReceipt is called', async () => {
    const events: string[] = [];

    let i = 0;
    const inferSpy = mock(async () => {
      events.push(`infer-${i++}`);
      return { ok: true, value: okResp(okJson(true, 'ok')) } as Result<
        ZGInferenceResult,
        ZGRouterError
      >;
    });
    const anchorSpy = mock(async () => {
      events.push('anchor');
      return {
        feedbackURI: 'zhgg://0g-storage/audit/0xabc',
        feedbackHash: '0xdeadbeef' as `0x${string}`,
      };
    });
    const postSpy = mock(async () => {
      events.push('post');
      return { ok: true, value: '0xreceipt' as `0x${string}` } as Result<`0x${string}`, PostError>;
    });

    const deps: AuditDeps = {
      infer: inferSpy as never,
      postReceipt: postSpy as never,
      erc8004Client: { giveFeedback: mock() } as unknown as Erc8004Client,
    };

    await runAudit(TARGET, deps, { ...OPTS, buildFeedbackAnchor: anchorSpy as never });

    // All infer calls happen first (parallel; order between them is not
    // asserted), then anchor, then post.
    const anchorIdx = events.indexOf('anchor');
    const postIdx = events.indexOf('post');
    const inferIndices = events
      .map((e, idx) => (e.startsWith('infer-') ? idx : -1))
      .filter((idx) => idx !== -1);

    expect(inferIndices.length).toBe(3);
    expect(Math.max(...inferIndices)).toBeLessThan(anchorIdx);
    expect(anchorIdx).toBeLessThan(postIdx);
    expect(anchorSpy).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('passes returned feedbackURI and feedbackHash through to postReceipt', async () => {
    const { deps, postedCtx } = makeDeps({
      inferResponses: [
        { ok: true, value: okResp(okJson(true, 'ok')) },
        { ok: true, value: okResp(okJson(true, 'ok')) },
        { ok: true, value: okResp(okJson(true, 'ok')) },
      ],
    });

    const anchor = {
      feedbackURI: 'zhgg://0g-storage/audit/0xreal',
      feedbackHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as `0x${string}`,
    };
    await runAudit(TARGET, deps, {
      ...OPTS,
      buildFeedbackAnchor: async () => anchor,
    });

    expect(postedCtx.value?.feedbackURI).toBe(anchor.feedbackURI);
    expect(postedCtx.value?.feedbackHashOverride).toBe(anchor.feedbackHash);
  });

  it('falls back to zhgg://placeholder URI when callback returns null (storage off)', async () => {
    const { deps, postedCtx } = makeDeps({
      inferResponses: [
        { ok: true, value: okResp(okJson(true, 'ok')) },
        { ok: true, value: okResp(okJson(true, 'ok')) },
        { ok: true, value: okResp(okJson(true, 'ok')) },
      ],
    });

    await runAudit(TARGET, deps, {
      ...OPTS,
      buildFeedbackAnchor: async () => null,
    });

    expect(postedCtx.value?.feedbackURI).toBe(`zhgg://placeholder/audit/${TARGET.agentName}`);
    expect(postedCtx.value?.feedbackHashOverride).toBeUndefined();
  });

  it('falls back to placeholder URI when no callback is provided', async () => {
    const { deps, postedCtx } = makeDeps({
      inferResponses: [
        { ok: true, value: okResp(okJson(true, 'ok')) },
        { ok: true, value: okResp(okJson(true, 'ok')) },
        { ok: true, value: okResp(okJson(true, 'ok')) },
      ],
    });

    await runAudit(TARGET, deps, OPTS);

    expect(postedCtx.value?.feedbackURI).toBe(`zhgg://placeholder/audit/${TARGET.agentName}`);
  });
});

describe('runAudit — receipt value mapping per verdict', () => {
  it('compliant verdict posts receipt with value=100', async () => {
    const { deps, postedCtx } = makeDeps({
      inferResponses: [
        { ok: true, value: okResp(okJson(true, 'ok')) },
        { ok: true, value: okResp(okJson(true, 'ok')) },
        { ok: true, value: okResp(okJson(true, 'ok')) },
      ],
    });
    const report = await runAudit(TARGET, deps, OPTS);
    expect(report.verdict).toBe('compliant');
    expect(postedCtx.value?.value).toBe(100);
    expect(postedCtx.value?.tag2).toBe('eu-ai-act:compliant');
  });

  it('non_compliant verdict posts receipt with value=0', async () => {
    const { deps, postedCtx } = makeDeps({
      inferResponses: [
        { ok: true, value: okResp(okJson(false, 'biometric scoring')) },
        { ok: true, value: okResp(okJson(true, 'ok')) },
        { ok: true, value: okResp(okJson(true, 'ok')) },
      ],
    });
    const report = await runAudit(TARGET, deps, OPTS);
    expect(report.verdict).toBe('non_compliant');
    expect(postedCtx.value?.value).toBe(0);
    expect(postedCtx.value?.tag2).toBe('eu-ai-act:non_compliant');
  });

  it('unclear verdict (all inferences fail) posts receipt with value=50', async () => {
    const { deps, postSpy, postedCtx } = makeDeps({
      inferResponses: [
        { ok: false, error: { kind: 'transport', reason: 'timeout' } },
        { ok: false, error: { kind: 'transport', reason: 'timeout' } },
        { ok: false, error: { kind: 'transport', reason: 'timeout' } },
      ],
    });
    const report = await runAudit(TARGET, deps, OPTS);
    expect(report.verdict).toBe('unclear');
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postedCtx.value?.value).toBe(50);
    expect(postedCtx.value?.tag2).toBe('eu-ai-act:unclear');
  });
});

describe('runAudit — single-probe inference failure surfaces in findings', () => {
  it('surfaces the error kind and reason in the failed probe finding', async () => {
    const { deps } = makeDeps({
      inferResponses: [
        { ok: true, value: okResp(okJson(true, 'ok')) },
        { ok: false, error: { kind: 'transport', reason: '429 too many requests', status: 429 } },
        { ok: true, value: okResp(okJson(true, 'ok')) },
      ],
    });
    const report = await runAudit(TARGET, deps, OPTS);

    const failedProbe = report.results[1]!;
    expect(failedProbe.compliant).toBeNull();
    expect(failedProbe.finding).toContain('transport');
    expect(failedProbe.finding).toContain('429');
    expect(failedProbe.finding).toContain('429 too many requests');

    // Verdict still computed from full result set — one null under 'all'
    // quorum drags to unclear, the remaining two compliant probes do not
    // override that.
    expect(report.verdict).toBe('unclear');
  });

  it('passes the receipt context with correct registry, agent, and timestamp', async () => {
    const { deps, postedCtx } = makeDeps({
      inferResponses: [
        { ok: true, value: okResp(okJson(true, 'ok'), '0xattest') },
        { ok: true, value: okResp(okJson(true, 'ok')) },
        { ok: true, value: okResp(okJson(true, 'ok')) },
      ],
    });
    await runAudit(TARGET, deps, OPTS);

    expect(postedCtx.value?.registryAddress).toBe(OPTS.registryAddress);
    expect(postedCtx.value?.agentRegistryCaip).toBe(OPTS.agentRegistryCaip);
    expect(postedCtx.value?.agentId).toBe(TARGET.agentId);
    expect(postedCtx.value?.clientAddress).toBe(OPTS.clientAddress);
    expect(postedCtx.value?.tag1).toBe('audit');
    expect(postedCtx.value?.endpoint).toBe('https://audit.zhgg.eth/v1');
    expect(postedCtx.value?.createdAt).toBe(OPTS.now);
    expect(postedCtx.value?.attestationRoot).toBe('0xattest');
    expect(postedCtx.value?.paymentTxHash).toBeNull();
  });
});
