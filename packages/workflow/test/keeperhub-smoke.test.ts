import { describe, it, expect, mock } from 'bun:test';

// `server-only` is mocked so the plugin transitively loads under bun.
// See plugin-shape.test.ts and KeeperHub's own vitest pattern.
mock.module('server-only', () => ({}));

const KEEPERHUB_MCP = process.env.KEEPERHUB_MCP_ENDPOINT ?? 'https://app.keeperhub.com/mcp';
const KEEPERHUB_TOKEN = process.env.KEEPERHUB_TOKEN;

/// End-to-end smoke test that confirms:
/// (1) our local MCP registry exposes well-formed tool descriptors
/// (2) those descriptors match the *shape* KeeperHub's hosted MCP returns
///
/// (2) is gated by KEEPERHUB_TOKEN so CI doesn't break without credentials.

describe('keeperhub MCP smoke', () => {
  it('local registry exposes 0g-tee-inference.run-inference', async () => {
    const { buildRegistry, listTools } = await import('../src/registry.js');
    const { plugin } = await import('../plugins/0g-tee-inference/index.js');

    const tools = listTools(buildRegistry([plugin]));
    const names = tools.map((t) => t.name);
    expect(names).toContain('0g-tee-inference.run-inference');

    const tool = tools.find((t) => t.name === '0g-tee-inference.run-inference')!;
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.properties).toBeDefined();
    expect(tool.inputSchema.required).toContain('prompt');
  });

  it.skipIf(!KEEPERHUB_TOKEN)(
    'KeeperHub hosted MCP returns a well-formed tools/list response',
    async () => {
      const res = await fetch(`${KEEPERHUB_MCP}/tools/list`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${KEEPERHUB_TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { result?: { tools?: unknown[] } };
      expect(body.result).toBeDefined();
      expect(Array.isArray(body.result?.tools)).toBe(true);
      expect((body.result?.tools ?? []).length).toBeGreaterThan(0);
    },
    20_000
  );
});
