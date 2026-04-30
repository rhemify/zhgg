/// MCP server entrypoint. Exposes registered plugin actions as MCP tools.
///
/// Library mode: import `createMcpServer` and bind to your own transport.
/// Standalone mode: `bun run packages/workflow/dev` starts an HTTP server
/// on `MCP_PORT || 7743`.
///
/// We deliberately keep the SDK surface narrow — a future major version of
/// `@modelcontextprotocol/sdk` is unlikely to break the Server class plus
/// the two RequestSchema handlers.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { plugin as zgPlugin } from '../plugins/0g-tee-inference/index.js';
import { buildRegistry, callTool, listTools, type PluginRegistry } from './registry.js';

export interface CreateMcpServerOptions {
  registry?: PluginRegistry;
  serverName?: string;
  serverVersion?: string;
}

export function createMcpServer(opts: CreateMcpServerOptions = {}): Server {
  const registry = opts.registry ?? buildRegistry([zgPlugin]);
  const server = new Server(
    {
      name: opts.serverName ?? 'zhgg-workflow',
      version: opts.serverVersion ?? '0.1.0',
    },
    {
      capabilities: { tools: {} },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listTools(registry),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await callTool(registry, request.params.name, request.params.arguments ?? {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  });

  return server;
}

// Standalone mode — start an HTTP server when invoked directly.
// Bun's `import.meta.main` is true when this file is the entry point.
if (import.meta.main) {
  const port = Number(process.env.MCP_PORT ?? 7743);
  const registry = buildRegistry([zgPlugin]);
  const tools = listTools(registry);

  Bun.serve({
    port,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === '/health') {
        return new Response(
          JSON.stringify({ status: 'ok', tools: tools.map((t) => t.name) }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.pathname === '/tools' && req.method === 'GET') {
        return new Response(JSON.stringify({ tools }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname === '/call' && req.method === 'POST') {
        const body = (await req.json()) as { name: string; arguments?: Record<string, unknown> };
        try {
          const result = await callTool(registry, body.name, body.arguments ?? {});
          return new Response(JSON.stringify({ result }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (e) {
          return new Response(
            JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }
      return new Response('Not Found', { status: 404 });
    },
  });
  console.log(`zhgg-workflow MCP server listening on :${port}`);
  console.log(`  tools: ${tools.map((t) => t.name).join(', ')}`);
}
