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
import { callTool, listTools, type PluginRegistry } from './registry.js';

export interface CreateMcpServerOptions {
  /// Required. Caller decides which plugins to register — the workflow
  /// package no longer eagerly imports any plugin folder, so consumers
  /// don't pay for plugin tsconfig path mappings (`@/lib/*`) they don't
  /// use. Standalone mode in this same file dynamically loads the
  /// 0g-tee-inference plugin only when invoked directly.
  registry: PluginRegistry;
  serverName?: string;
  serverVersion?: string;
}

export function createMcpServer(opts: CreateMcpServerOptions): Server {
  const { registry } = opts;
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
/// it without binding a port. Tool list is computed PER REQUEST (not
/// cached at handler construction) so callers that mutate the registry
/// after building the handler see live state on `/health` and `/tools`.
export function createHttpHandler(opts: HttpHandlerOptions): (req: Request) => Promise<Response> {
  const { registry, authToken } = opts;

  return async (req: Request) => {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      // Liveness != readiness. A registry with zero tools means the server
      // is up but there's nothing it can usefully serve — clients should
      // back off rather than retry against a permanently empty endpoint.
      const liveTools = listTools(registry);
      if (liveTools.length === 0) {
        return jsonResponse({ status: 'unhealthy', reason: 'no tools registered' }, 503);
      }
      return jsonResponse({ status: 'ok', tools: liveTools.map((t) => t.name) });
    }
    if (url.pathname === '/tools' && req.method === 'GET') {
      return jsonResponse({ tools: listTools(registry) });
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

// Standalone-mode entrypoint lives at `./standalone.ts` so library
// consumers (`import { createMcpServer } from '@zhgg/workflow'`) never
// transitively type-check the plugin folder, which uses path-mapped
// `@/lib/*` imports that exist only in this package's tsconfig.
// Run: `bun run packages/workflow/src/standalone.ts`
