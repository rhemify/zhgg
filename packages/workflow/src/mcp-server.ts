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

/// Maximum request body the standalone server accepts (1 MiB). Larger
/// bodies are rejected with 413 — caps DOS surface and signals to clients
/// that this is not a generic uploads endpoint.
const MAX_BODY_BYTES = 1024 * 1024;

interface CallBody {
  name: string;
  arguments?: Record<string, unknown>;
}

function isCallBody(value: unknown): value is CallBody {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== 'string') return false;
  if (v.arguments !== undefined && (typeof v.arguments !== 'object' || v.arguments === null)) {
    return false;
  }
  return true;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export interface HttpHandlerOptions {
  registry: PluginRegistry;
  authToken: string;
}

/// Builds the standalone HTTP request handler. Exported so tests can call
/// it without binding a port.
export function createHttpHandler(opts: HttpHandlerOptions): (req: Request) => Promise<Response> {
  const { registry, authToken } = opts;
  const tools = listTools(registry);

  return async (req: Request) => {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      // Liveness != readiness. A registry with zero tools means the server
      // is up but there's nothing it can usefully serve — clients should
      // back off rather than retry against a permanently empty endpoint.
      if (tools.length === 0) {
        return jsonResponse({ status: 'unhealthy', reason: 'no tools registered' }, 503);
      }
      return jsonResponse({ status: 'ok', tools: tools.map((t) => t.name) });
    }
    if (url.pathname === '/tools' && req.method === 'GET') {
      return jsonResponse({ tools });
    }
    if (url.pathname === '/call' && req.method === 'POST') {
      const auth = req.headers.get('Authorization');
      if (auth !== `Bearer ${authToken}`) {
        return jsonResponse({ error: 'unauthorized' }, 401);
      }
      const contentLength = Number(req.headers.get('Content-Length') ?? 0);
      if (contentLength > MAX_BODY_BYTES) {
        return jsonResponse({ error: 'body too large' }, 413);
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonResponse({ error: 'invalid JSON' }, 400);
      }
      if (!isCallBody(body)) {
        return jsonResponse({ error: 'invalid body shape: expected { name, arguments? }' }, 400);
      }
      try {
        const result = await callTool(registry, body.name, body.arguments ?? {});
        return jsonResponse({ result });
      } catch (e) {
        return jsonResponse(
          { error: e instanceof Error ? e.message : String(e) },
          400
        );
      }
    }
    return new Response('Not Found', { status: 404 });
  };
}

// Standalone mode — start an HTTP server when invoked directly.
// Bun's `import.meta.main` is true when this file is the entry point.
if (import.meta.main) {
  const port = Number(process.env.MCP_PORT ?? 7743);
  // Auth: require a bearer token on /call so a process bound to localhost
  // can't be exploited by other processes on the same box. /health and
  // /tools are read-only and OK to leave open for liveness probes.
  const authToken = process.env.MCP_AUTH_TOKEN;
  if (!authToken) {
    console.error('MCP_AUTH_TOKEN env var is required for /call');
    process.exit(1);
  }

  const registry = buildRegistry([zgPlugin]);
  const tools = listTools(registry);
  const handler = createHttpHandler({ registry, authToken });

  Bun.serve({ port, fetch: handler });
  console.log(`zhgg-workflow MCP server listening on :${port}`);
  console.log(`  tools: ${tools.map((t) => t.name).join(', ')}`);
}
