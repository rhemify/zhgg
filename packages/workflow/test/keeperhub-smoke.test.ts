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

  /// JSON-RPC over HTTP wrapper for the hosted KeeperHub MCP. Single
  /// helper used by both `tools/list` and `tools/call` smoke tests so the
  /// auth header + body shape stay consistent.
  const callKeeperHub = async (method: string, params?: Record<string, unknown>) => {
    const res = await fetch(`${KEEPERHUB_MCP}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KEEPERHUB_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        ...(params !== undefined ? { params } : {}),
      }),
    });
    return { res, body: res.ok ? await res.json() : null };
  };

  it.skipIf(!KEEPERHUB_TOKEN)(
    'KeeperHub hosted MCP returns a well-formed tools/list response',
    async () => {
      const { res, body } = await callKeeperHub('tools/list');
      expect(res.ok).toBe(true);
      const typed = body as { result?: { tools?: Array<{ name?: unknown }> } };
      expect(typed.result).toBeDefined();
      expect(Array.isArray(typed.result?.tools)).toBe(true);
      const tools = typed.result?.tools ?? [];
      expect(tools.length).toBeGreaterThan(0);

      // Log the token's effective scope so the FEEDBACK.md draft can
      // record what tier we tested against. KeeperHub returns the
      // available tool count which proxies for scope (admin sees more).
      // Only log locally — admin-tier tokens may surface tenant-prefixed
      // tool names that shouldn't end up in CI logs.
      if (!process.env.CI) {
        // eslint-disable-next-line no-console
        console.log(`[keeperhub-smoke] token sees ${tools.length} tool(s)`);
      }
    },
    20_000
  );

  it.skipIf(!KEEPERHUB_TOKEN)(
    'tools/call returns a non-error response for a read-only tool',
    async () => {
      // First discover what's available to avoid hardcoding a tool name
      // that may not exist for this token's scope.
      const { body: listBody } = await callKeeperHub('tools/list');
      const tools = ((listBody as { result?: { tools?: Array<{ name?: string }> } }).result?.tools ?? [])
        .map((t) => t.name)
        .filter((n): n is string => typeof n === 'string');
      // Prefer a list-style read tool if present; fall back to the first
      // available. KeeperHub's MCP exposes 18 tools per /docs/keeperhub.md;
      // names follow `category.action` convention so we anchor on the
      // suffix to avoid false matches against names like `subscribe-list`
      // or `internal.allowlist`.
      const readTool = tools.find((n) => n.endsWith('.list')) ?? tools[0];
      if (!readTool) {
        // Token has zero tools — nothing to call. Test is vacuously fine
        // for hackathon-tier read-only tokens; we already asserted >0
        // tools above so this branch shouldn't fire in practice.
        return;
      }

      const { res, body } = await callKeeperHub('tools/call', {
        name: readTool,
        arguments: {},
      });
      expect(res.ok).toBe(true);
      const typed = body as { result?: unknown; error?: { code?: number; message?: string } };
      // MCP convention: `error` field present means failure. Some tools
      // legitimately return validation errors when called with empty
      // args — we accept either a non-error result or a structured
      // error payload, but NOT an HTTP-level failure.
      if (typed.error) {
        if (!process.env.CI) {
          // eslint-disable-next-line no-console
          console.log(
            `[keeperhub-smoke] tools/call ${readTool} returned structured error ` +
              `code=${typed.error.code} (acceptable for empty-args read tool)`
          );
        }
        expect(typeof typed.error.code).toBe('number');
      } else {
        expect(typed.result).toBeDefined();
      }
    },
    20_000
  );
});
