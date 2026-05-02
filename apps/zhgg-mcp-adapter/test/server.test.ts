/// Unit tests for the adapter's fetch handler.
///
/// We exercise the route table via `createFetchHandler({...})` directly —
/// no port binding, no real chain calls. Each test injects exactly the
/// dep it needs (a stubbed `runAuditFn` / `queryOracleFn` /
/// `executeSwapFn`) so the handler logic is verified in isolation.

import { describe, it, expect } from 'bun:test';
import { createFetchHandler } from '../src/server.js';
import type { AuditReport } from '@zhgg/audit-agent';
import type { OracleResponse } from '@zhgg/oracle-agent';

const TOKEN = 'test-bearer-supersecret';

const FAKE_REPORT: AuditReport = {
  target: { agentId: 7n, agentName: 'oracle.zhgg.eth' },
  verdict: 'compliant',
  results: [
    { id: 'eu-aiact-article-5', articleRef: 'EU AI Act Article 5', compliant: true, finding: 'ok' },
  ],
  findings: ['ok'],
  attestationRoot: null,
  receiptTxHash: '0xabc',
};

function buildHandler() {
  return createFetchHandler({
    authToken: TOKEN,
    routes: {
      audit: {
        runAuditFn: async () => FAKE_REPORT,
      },
      oracle: {
        // Default — overridden per test below where needed.
        queryOracleFn: async (): Promise<OracleResponse> => ({
          ok: true,
          topic: 'eu-ai-act',
          asOf: '2026-04-30T00:00:00Z',
          data: { kind: 'regulatory', deltas: [] },
        }),
      },
      swap: {
        // The test never invokes the swap route's executeSwap path —
        // we stub it out with a fixed receipt. The clients triple is a
        // type-only placeholder.
        clients: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          publicClient: {} as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          walletClient: {} as any,
          account: '0x0000000000000000000000000000000000000000',
        },
        executeSwapFn: async () => ({
          ok: true as const,
          value: {
            txHash: '0xdead' as `0x${string}`,
            fromAmount: 1000n,
            toAmountMin: 0n,
            poolFee: null,
            route: 'weth9_deposit' as const,
          },
        }),
      },
    },
  });
}

function authHeaders(token: string = TOKEN): Record<string, string> {
  return {
    'authorization': `Bearer ${token}`,
    'content-type': 'application/json',
  };
}

describe('GET /agents', () => {
  it('returns the three agents with KH-compatible shape', async () => {
    const handler = buildHandler();
    const res = await handler(
      new Request('http://localhost/agents', { headers: authHeaders() }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<Record<string, unknown>> };
    expect(body.agents).toHaveLength(3);
    const ids = body.agents.map((a) => a.id).sort();
    expect(ids).toEqual(['audit', 'oracle', 'swap']);
    for (const a of body.agents) {
      expect(typeof a.id).toBe('string');
      expect(typeof a.name).toBe('string');
      expect(typeof a.description).toBe('string');
      expect(typeof a.priceUsdcPerCall).toBe('string');
      expect(typeof a.inputSchema).toBe('object');
      const schema = a.inputSchema as { type: string; required: string[]; properties: object };
      expect(schema.type).toBe('object');
      expect(Array.isArray(schema.required)).toBe(true);
    }
  });

  it('rejects requests without a bearer with 401', async () => {
    const handler = buildHandler();
    const res = await handler(new Request('http://localhost/agents'));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { kind: string; reason: string } };
    expect(body.error.kind).toBe('unauthorized');
    expect(body.error.reason).toBe('missing_authorization');
  });

  it('rejects requests with a wrong bearer with 401', async () => {
    const handler = buildHandler();
    const res = await handler(
      new Request('http://localhost/agents', {
        headers: { authorization: 'Bearer wrong-token' },
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { kind: string; reason: string } };
    expect(body.error.reason).toBe('invalid_token');
  });
});

describe('POST /agents/audit/call', () => {
  it('without auth → 401', async () => {
    const handler = buildHandler();
    const res = await handler(
      new Request('http://localhost/agents/audit/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: '7', agentName: 'x', manifest: 'y' }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('bad input (missing manifest) → 400 with named missing key', async () => {
    const handler = buildHandler();
    const res = await handler(
      new Request('http://localhost/agents/audit/call', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ agentId: '7', agentName: 'x' }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { kind: string; missing?: string; reason: string } };
    expect(body.error.kind).toBe('bad_input');
    expect(body.error.missing).toBe('manifest');
    expect(body.error.reason).toContain('manifest');
  });

  it('valid input runs runAuditFn and returns the report (agentId stringified)', async () => {
    const handler = buildHandler();
    const res = await handler(
      new Request('http://localhost/agents/audit/call', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          agentId: '7',
          agentName: 'oracle.zhgg.eth',
          manifest: 'returns reg deltas + prices',
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: { target: { agentId: string; agentName: string }; verdict: string };
    };
    expect(body.report.target.agentId).toBe('7');
    expect(body.report.target.agentName).toBe('oracle.zhgg.eth');
    expect(body.report.verdict).toBe('compliant');
  });
});

describe('POST /agents/oracle/call', () => {
  it('valid eu-ai-act query returns the canned regulatory deltas (no synthetic fallback)', async () => {
    // Structural sanity check: the oracle route must NOT have a code
    // path that catches an oracle failure and substitutes a fake
    // success. We assert there is no try/catch around the queryOracle
    // call AND that no `ok: true` literal appears in the handler body
    // outside of the pass-through `result` (which only fires when the
    // upstream itself returned ok). This protects against a future
    // contributor wrapping the call with a "graceful fallback".
    const src = await Bun.file('apps/zhgg-mcp-adapter/src/routes/oracle.ts').text();
    // Extract the body of `handleOracleCall` and scan it.
    const fnMatch = /export async function handleOracleCall[\s\S]+$/m.exec(src);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];
    // No try/catch wrapping the call.
    expect(fnBody).not.toMatch(/try\s*{[^}]*await\s+fn\(/);
    // No literal `ok: true` constructed in the handler (only the
    // upstream's own response is forwarded).
    expect(fnBody).not.toMatch(/ok:\s*true/);

    const handler = createFetchHandler({
      authToken: TOKEN,
      routes: {
        audit: { runAuditFn: async () => FAKE_REPORT },
        oracle: {
          queryOracleFn: async (q): Promise<OracleResponse> => {
            expect(q.topic).toBe('eu-ai-act');
            return {
              ok: true,
              topic: 'eu-ai-act',
              asOf: '2026-04-30T00:00:00Z',
              data: {
                kind: 'regulatory',
                deltas: [
                  {
                    article: 'Article 13',
                    effectiveDate: '2026-08-02',
                    summary: 'Transparency for high-risk AI systems.',
                  },
                ],
              },
            };
          },
        },
        swap: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          clients: { publicClient: {} as any, walletClient: {} as any, account: '0x0' },
          executeSwapFn: async () => ({ ok: false as const, error: { kind: 'invalid_amount' as const, reason: 'unused' } }),
        },
      },
    });

    const res = await handler(
      new Request('http://localhost/agents/oracle/call', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ topic: 'eu-ai-act' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        topic: string;
        data: { kind: string; deltas: Array<{ article: string }> };
      };
    };
    expect(body.result.topic).toBe('eu-ai-act');
    expect(body.result.data.kind).toBe('regulatory');
    expect(body.result.data.deltas[0]?.article).toBe('Article 13');
  });

  it('bad enum value → 400 with named key', async () => {
    const handler = buildHandler();
    const res = await handler(
      new Request('http://localhost/agents/oracle/call', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ topic: 'made-up-topic' }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { kind: string; key?: string } };
    expect(body.error.kind).toBe('bad_input');
    expect(body.error.key).toBe('topic');
  });
});

describe('GET /health', () => {
  it('returns 200 without auth', async () => {
    const handler = buildHandler();
    const res = await handler(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('zhgg-mcp-adapter');
  });
});

describe('unknown route', () => {
  it('returns 404', async () => {
    const handler = buildHandler();
    const res = await handler(new Request('http://localhost/nope'));
    expect(res.status).toBe(404);
  });
});
