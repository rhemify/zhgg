import { describe, it, expect } from 'bun:test';
import {
  createKeeperFromMcpClient,
  type McpLikeClient,
  type SettleParams,
} from '../src/keeper.js';

type CallArgs = { name: string; arguments?: Record<string, unknown> };
type CallResp = {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

function mockClient(
  handler: (req: CallArgs) => Promise<CallResp> | CallResp,
): { client: McpLikeClient; calls: CallArgs[]; closed: { value: boolean } } {
  const calls: CallArgs[] = [];
  const closed = { value: false };
  const client: McpLikeClient = {
    async callTool(req) {
      calls.push(req);
      return await handler(req);
    },
    async close() {
      closed.value = true;
    },
  };
  return { client, calls, closed };
}

const baseParams: SettleParams = {
  tx: '0xdeadbeef',
  chain: 84532,
};

describe('keeper.settle', () => {
  it('returns Result.ok on successful settle', async () => {
    const { client } = mockClient(() => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ txHash: '0xabc', confirmed: true }),
        },
      ],
    }));
    const keeper = createKeeperFromMcpClient(client);
    const r = await keeper.settle(baseParams);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.txHash).toBe('0xabc');
      expect(r.value.confirmed).toBe(true);
    }
  });

  it('isError=true => transport error', async () => {
    const { client } = mockClient(() => ({
      isError: true,
      content: [{ type: 'text', text: 'rpc node down' }],
    }));
    const keeper = createKeeperFromMcpClient(client);
    const r = await keeper.settle(baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('transport');
      expect(r.error.reason).toBe('rpc node down');
    }
  });

  it('empty content array => malformed_response', async () => {
    const { client } = mockClient(() => ({ content: [] }));
    const keeper = createKeeperFromMcpClient(client);
    const r = await keeper.settle(baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('malformed_response');
  });

  it('non-text content type => malformed_response', async () => {
    const { client } = mockClient(() => ({
      content: [{ type: 'image', text: 'irrelevant' }],
    }));
    const keeper = createKeeperFromMcpClient(client);
    const r = await keeper.settle(baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('malformed_response');
      expect(r.error.reason).toContain('image');
    }
  });

  it('invalid JSON in text => malformed_response', async () => {
    const { client } = mockClient(() => ({
      content: [{ type: 'text', text: 'not-json{{' }],
    }));
    const keeper = createKeeperFromMcpClient(client);
    const r = await keeper.settle(baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('malformed_response');
      expect(r.error.reason).toContain('invalid JSON');
    }
  });

  it('JSON missing txHash => malformed_response', async () => {
    const { client } = mockClient(() => ({
      content: [
        { type: 'text', text: JSON.stringify({ confirmed: true }) },
      ],
    }));
    const keeper = createKeeperFromMcpClient(client);
    const r = await keeper.settle(baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('malformed_response');
      expect(r.error.reason).toContain('txHash');
    }
  });

  it('confirmed=false => settlement_failed', async () => {
    const { client } = mockClient(() => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ txHash: '0xfeed', confirmed: false }),
        },
      ],
    }));
    const keeper = createKeeperFromMcpClient(client);
    const r = await keeper.settle(baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('settlement_failed');
      expect(r.error.reason).toContain('0xfeed');
    }
  });

  it('uses custom toolName', async () => {
    const { client, calls } = mockClient(() => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ txHash: '0x01', confirmed: true }),
        },
      ],
    }));
    const keeper = createKeeperFromMcpClient(client, {
      toolName: 'keeper.execute',
    });
    await keeper.settle(baseParams);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('keeper.execute');
  });

  it('uses custom requestMapper', async () => {
    const { client, calls } = mockClient(() => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ txHash: '0x02', confirmed: true }),
        },
      ],
    }));
    const keeper = createKeeperFromMcpClient(client, {
      requestMapper: (p) => ({
        rawTx: p.tx,
        chainId: p.chain,
        retries: p.maxRetries ?? 9,
      }),
    });
    await keeper.settle({ tx: '0xaaa', chain: 1, maxRetries: 7 });
    expect(calls[0]?.arguments).toEqual({
      rawTx: '0xaaa',
      chainId: 1,
      retries: 7,
    });
  });

  it('default maxRetries=5 when not provided', async () => {
    const { client, calls } = mockClient(() => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ txHash: '0x03', confirmed: true }),
        },
      ],
    }));
    // attachFee=false: assert the raw tx shape without the ERC-8021 suffix.
    // ERC-8021 attachment is covered by erc8021.test.ts; this test checks
    // the maxRetries default in isolation.
    const keeper = createKeeperFromMcpClient(client, { attachFee: false });
    await keeper.settle(baseParams);
    expect(calls[0]?.arguments).toEqual({
      tx: '0xdeadbeef',
      chain: 84532,
      maxRetries: 5,
    });
  });

  it('callTool throws => transport error with message', async () => {
    const { client } = mockClient(() => {
      throw new Error('socket reset');
    });
    const keeper = createKeeperFromMcpClient(client);
    const r = await keeper.settle(baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('transport');
      expect(r.error.reason).toBe('socket reset');
    }
  });

  it('default attachFee=true wraps tx with ERC-8021 suffix', async () => {
    // Smoke test for the production default. The default requestMapper calls
    // appendFee(params.tx) which adds 24 bytes (48 hex chars) to the calldata.
    const { client, calls } = mockClient(() => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ txHash: '0xfee', confirmed: true }),
        },
      ],
    }));
    const keeper = createKeeperFromMcpClient(client);
    await keeper.settle(baseParams);
    const wrappedTx = calls[0]!.arguments!['tx'];
    expect(typeof wrappedTx).toBe('string');
    expect(wrappedTx as string).not.toBe(baseParams.tx);
    // baseParams.tx is '0xdeadbeef' (10 chars). After appendFee: 10 + 48 = 58 chars.
    expect((wrappedTx as string).length).toBe(58);
    expect((wrappedTx as string).startsWith('0xdeadbeef')).toBe(true);
  });

  it('close() delegates to underlying client', async () => {
    const { client, closed } = mockClient(() => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ txHash: '0x04', confirmed: true }),
        },
      ],
    }));
    const keeper = createKeeperFromMcpClient(client);
    expect(closed.value).toBe(false);
    await keeper.close();
    expect(closed.value).toBe(true);
  });
});
