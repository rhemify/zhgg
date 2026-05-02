/// keeperhub-agent — direct-API client unit tests.
///
/// We mock the `fetch` shape (status / ok / text) and assert:
///   - The Authorization header carries `Bearer kh_…` (the only place
///     in this codebase that handles that key — leak-test).
///   - URL construction for each endpoint matches the documented KH
///     surface in `docs/keeperhub-research/kh-api.md`.
///   - 4xx responses map to the right typed error kind (NEVER fall
///     through as a synthetic success).
///   - Missing-field responses surface as `malformed_response` with a
///     reason that quotes the offending payload.
///   - `buildKHFromEnv` refuses both empty and `wfb_`-prefixed keys.

import { describe, expect, it } from 'bun:test';
import { createKHClient, type KHFetch, type KHFetchResponse } from '../src/client.js';
import {
  buildKHFromEnv,
  executeKHCall,
} from '../src/index.js';

const KEY = 'kh_test_abcdef0123456789';

interface Recorded {
  url: string;
  method: string | undefined;
  headers: Record<string, string> | undefined;
  body: string | undefined;
}

function mockFetch(
  reply: (req: Recorded) => { status: number; body: string },
): { fetchImpl: KHFetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl: KHFetch = async (url, init) => {
    const rec: Recorded = {
      url,
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    };
    calls.push(rec);
    const r = reply(rec);
    const res: KHFetchResponse = {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      text: async () => r.body,
    };
    return res;
  };
  return { fetchImpl, calls };
}

describe('createKHClient — auth + URL construction', () => {
  it('attaches Bearer header on every GET', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, body: '{}' }));
    const client = createKHClient({ apiKey: KEY, fetchImpl });
    await client.get('/api/analytics/spend-cap');
    expect(calls.length).toBe(1);
    const auth = calls[0]!.headers?.Authorization;
    expect(auth).toBe(`Bearer ${KEY}`);
  });

  it('attaches Bearer header on POST + Content-Type when body present', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, body: '{"executionId":"e1","status":"pending"}' }));
    const client = createKHClient({ apiKey: KEY, fetchImpl });
    await client.post('/api/workflow/wf-1/execute', { inputs: { foo: 'bar' } });
    expect(calls.length).toBe(1);
    const c = calls[0]!;
    expect(c.headers?.Authorization).toBe(`Bearer ${KEY}`);
    expect(c.headers?.['Content-Type']).toBe('application/json');
    expect(c.body).toBe(JSON.stringify({ inputs: { foo: 'bar' } }));
    expect(c.method).toBe('POST');
  });

  it('serialises query params and drops undefined keys', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, body: '[]' }));
    const client = createKHClient({ apiKey: KEY, fetchImpl });
    await client.get('/api/analytics/runs', { status: 'success', range: undefined });
    expect(calls[0]!.url).toBe('https://app.keeperhub.com/api/analytics/runs?status=success');
  });

  it('honours custom baseUrl and trims trailing slashes', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, body: '{}' }));
    const client = createKHClient({
      apiKey: KEY,
      baseUrl: 'https://staging.keeperhub.test/',
      fetchImpl,
    });
    await client.get('/api/analytics/spend-cap');
    expect(calls[0]!.url).toBe('https://staging.keeperhub.test/api/analytics/spend-cap');
  });

  it('refuses to construct without an apiKey', () => {
    expect(() => createKHClient({ apiKey: '' })).toThrow();
  });
});

describe('createKHClient — error mapping (no synthetic success)', () => {
  it('maps 401 to unauthorized with status + body excerpt', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 401, body: '{"error":"bad token"}' }));
    const client = createKHClient({ apiKey: KEY, fetchImpl });
    const r = await client.get('/api/analytics/spend-cap');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('unauthorized');
    expect(r.error.status).toBe(401);
    expect(r.error.reason).toContain('bad token');
  });

  it('maps 404 to not_found', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 404, body: 'not here' }));
    const client = createKHClient({ apiKey: KEY, fetchImpl });
    const r = await client.get('/api/workflow/missing/execute');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('not_found');
  });

  it('maps 422 to unprocessable (spending cap exceeded)', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 422, body: '{"code":"SPENDING_CAP_EXCEEDED"}' }));
    const client = createKHClient({ apiKey: KEY, fetchImpl });
    const r = await client.post('/api/workflow/wf-1/execute', {});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('unprocessable');
    expect(r.error.reason).toContain('SPENDING_CAP_EXCEEDED');
  });

  it('maps 500 to server_error', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 500, body: 'oops' }));
    const client = createKHClient({ apiKey: KEY, fetchImpl });
    const r = await client.get('/api/analytics/runs');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('server_error');
  });

  it('does NOT include the API key in 4xx error reasons', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 401, body: 'unauthorized' }));
    const client = createKHClient({ apiKey: KEY, fetchImpl });
    const r = await client.get('/api/analytics/spend-cap');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.reason).not.toContain(KEY);
  });

  it('flags non-JSON success bodies as malformed_response', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 200, body: '<html>oops</html>' }));
    const client = createKHClient({ apiKey: KEY, fetchImpl });
    const r = await client.get('/api/analytics/spend-cap');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('malformed_response');
  });
});

describe('executeKHCall — endpoint URL construction', () => {
  it('workflow_trigger hits POST /api/workflow/{id}/execute with body', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      status: 200,
      body: '{"executionId":"exec-1","status":"pending"}',
    }));
    const client = createKHClient({ apiKey: KEY, fetchImpl });
    const r = await executeKHCall(
      { kind: 'workflow_trigger', workflowId: 'wf-42', inputs: { x: 1 } },
      { client },
    );
    expect(calls[0]!.url).toBe('https://app.keeperhub.com/api/workflow/wf-42/execute');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toBe(JSON.stringify({ inputs: { x: 1 } }));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.kind).toBe('workflow_trigger');
    if (r.value.kind !== 'workflow_trigger') throw new Error('unreachable');
    expect(r.value.value.executionId).toBe('exec-1');
  });

  it('workflow_status hits GET /api/workflows/executions/{id}/status', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        executionId: 'exec-1',
        status: 'success',
        steps: [{ nodeId: 'n1', status: 'success', txHash: '0xdead' }],
      }),
    }));
    const client = createKHClient({ apiKey: KEY, fetchImpl });
    const r = await executeKHCall(
      { kind: 'workflow_status', executionId: 'exec-1' },
      { client },
    );
    expect(calls[0]!.url).toBe('https://app.keeperhub.com/api/workflows/executions/exec-1/status');
    expect(calls[0]!.method).toBe('GET');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    if (r.value.kind !== 'workflow_status') throw new Error('unreachable');
    expect(r.value.value.steps?.[0]?.txHash).toBe('0xdead');
  });

  it('analytics_runs accepts both array and {runs:[]} shapes', async () => {
    // Direct-array shape.
    {
      const { fetchImpl } = mockFetch(() => ({
        status: 200,
        body: JSON.stringify([{ executionId: 'a', status: 'success' }]),
      }));
      const client = createKHClient({ apiKey: KEY, fetchImpl });
      const r = await executeKHCall({ kind: 'analytics_runs', status: 'success' }, { client });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('unreachable');
      if (r.value.kind !== 'analytics_runs') throw new Error('unreachable');
      expect(r.value.value.length).toBe(1);
    }
    // Wrapped shape.
    {
      const { fetchImpl, calls } = mockFetch(() => ({
        status: 200,
        body: JSON.stringify({ runs: [{ executionId: 'a' }, { executionId: 'b' }] }),
      }));
      const client = createKHClient({ apiKey: KEY, fetchImpl });
      const r = await executeKHCall(
        { kind: 'analytics_runs', range: '24h' },
        { client },
      );
      expect(calls[0]!.url).toBe('https://app.keeperhub.com/api/analytics/runs?range=24h');
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('unreachable');
      if (r.value.kind !== 'analytics_runs') throw new Error('unreachable');
      expect(r.value.value.length).toBe(2);
    }
  });

  it('spend_cap parses { capWei, remainingWei, resetAt }', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        capWei: '1000000000000000000',
        remainingWei: '750000000000000000',
        resetAt: '2026-05-03T00:00:00.000Z',
      }),
    }));
    const client = createKHClient({ apiKey: KEY, fetchImpl });
    const r = await executeKHCall({ kind: 'spend_cap' }, { client });
    expect(calls[0]!.url).toBe('https://app.keeperhub.com/api/analytics/spend-cap');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    if (r.value.kind !== 'spend_cap') throw new Error('unreachable');
    expect(r.value.value.capWei).toBe('1000000000000000000');
    expect(r.value.value.remainingWei).toBe('750000000000000000');
  });
});

describe('executeKHCall — malformed responses', () => {
  it('workflow_trigger: missing executionId → malformed_response', async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ status: 'pending' }),
    }));
    const client = createKHClient({ apiKey: KEY, fetchImpl });
    const r = await executeKHCall(
      { kind: 'workflow_trigger', workflowId: 'wf-1' },
      { client },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('malformed_response');
    expect(r.error.reason).toContain('executionId');
  });

  it('workflow_status: unknown status → malformed_response', async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ executionId: 'e1', status: 'completed' /* drift */ }),
    }));
    const client = createKHClient({ apiKey: KEY, fetchImpl });
    const r = await executeKHCall(
      { kind: 'workflow_status', executionId: 'e1' },
      { client },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('malformed_response');
    expect(r.error.reason).toContain('completed');
  });

  it('spend_cap: missing capWei → malformed_response', async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ remainingWei: '1' }),
    }));
    const client = createKHClient({ apiKey: KEY, fetchImpl });
    const r = await executeKHCall({ kind: 'spend_cap' }, { client });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('malformed_response');
  });
});

describe('buildKHFromEnv — env validation (no key in error reasons)', () => {
  it('refuses missing KH_API_KEY', () => {
    const r = buildKHFromEnv({});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('env_missing');
    expect(r.error.reason).toContain('KH_API_KEY');
    expect(r.error.reason).not.toContain('kh_test');
  });

  it('refuses webhook-only wfb_ keys', () => {
    const r = buildKHFromEnv({ KH_API_KEY: 'wfb_xyz' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('env_missing');
    expect(r.error.reason).toContain('kh_');
    expect(r.error.reason).not.toContain('wfb_xyz');
  });

  it('accepts kh_-prefixed keys and respects KEEPERHUB_API_URL', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ capWei: '1', remainingWei: '1' }),
    }));
    const built = buildKHFromEnv(
      { KH_API_KEY: KEY, KEEPERHUB_API_URL: 'https://kh.local' },
      { fetchImpl },
    );
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('unreachable');
    await built.value.get('/api/analytics/spend-cap');
    expect(calls[0]!.url).toBe('https://kh.local/api/analytics/spend-cap');
    expect(calls[0]!.headers?.Authorization).toBe(`Bearer ${KEY}`);
  });
});
