/// Bun.serve route table + auth gate.
///
/// Exposes `createFetchHandler({ auth, routes })` as the unit-test entry
/// point: tests call `await handler(new Request(...))` directly without
/// binding a port. `startServer({ port, auth, routes })` is the
/// production entry — `index.ts` calls it after env validation.
///
/// Route table:
///   GET  /health                  → 200 { ok, service }
///   GET  /agents                  → 200 list of AgentDescriptors
///   POST /agents/audit/call       → audit handler
///   POST /agents/oracle/call      → oracle handler
///   POST /agents/swap/call        → swap handler
///
/// Every /agents/* route is gated by `Authorization: Bearer <token>`
/// (see `auth.ts`). 401 fires BEFORE the body is parsed — we never
/// echo the bearer back, even on a malformed header.

import { checkBearer } from './auth.js';
import { handleListAgents } from './routes/agents.js';
import { handleAuditCall, type AuditRouteDeps } from './routes/audit.js';
import { handleOracleCall, type OracleRouteDeps } from './routes/oracle.js';
import { handleSwapCall, type SwapRouteDeps } from './routes/swap.js';

export interface ServerRouteDeps {
  audit: AuditRouteDeps;
  oracle: OracleRouteDeps;
  swap: SwapRouteDeps;
}

export interface ServerConfig {
  /// Bearer token expected in every `/agents/*` request. The server
  /// MUST refuse to start when this is empty — `index.ts` enforces.
  authToken: string;
  routes: ServerRouteDeps;
}

export type FetchHandler = (req: Request) => Promise<Response>;

export function createFetchHandler(cfg: ServerConfig): FetchHandler {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    // Health is unauthenticated — KH ping checks need a 200 without a
    // bearer to wire up the integration.
    if (method === 'GET' && path === '/health') {
      return Response.json({ ok: true, service: 'zhgg-mcp-adapter' });
    }

    // All /agents/* paths require the bearer. Check ONCE here so a
    // missing/malformed header never reaches the route handlers.
    if (path === '/agents' || path.startsWith('/agents/')) {
      const auth = checkBearer(req.headers.get('authorization'), cfg.authToken);
      if (!auth.ok) {
        return Response.json(
          { error: { kind: 'unauthorized', reason: auth.reason } },
          { status: auth.status },
        );
      }
    }

    if (method === 'GET' && path === '/agents') {
      return handleListAgents();
    }

    if (method === 'POST' && path === '/agents/audit/call') {
      return handleAuditCall(req, cfg.routes.audit);
    }

    if (method === 'POST' && path === '/agents/oracle/call') {
      return handleOracleCall(req, cfg.routes.oracle);
    }

    if (method === 'POST' && path === '/agents/swap/call') {
      return handleSwapCall(req, cfg.routes.swap);
    }

    return Response.json(
      { error: { kind: 'not_found', reason: `${method} ${path}` } },
      { status: 404 },
    );
  };
}

export interface ServeResult {
  /// The Bun server handle — caller can stop it via `.stop()`.
  server: ReturnType<typeof Bun.serve>;
  port: number;
}

export function startServer(cfg: ServerConfig & { port: number }): ServeResult {
  const handler = createFetchHandler(cfg);
  const server = Bun.serve({
    port: cfg.port,
    fetch: handler,
  });
  // `server.port` is typed as `number | undefined` in Bun's types
  // because a 0-port server's resolved port is determined async. We
  // always pass a concrete `cfg.port`, so fall back to it.
  return { server, port: server.port ?? cfg.port };
}
