/// `bun run apps/zhgg-mcp-adapter/src/index.ts` — boots the HTTP server
/// that exposes audit / oracle / swap as KeeperHub-callable endpoints.
///
/// Boot rules:
///   1. `MCP_AUTH_TOKEN` MUST be set. Empty / missing → fail loudly,
///      exit 1. We never expose an open marketplace endpoint.
///   2. Live chain wiring is best-effort: each agent's deps are built
///      independently, and a missing env for one agent does NOT block
///      the others — the unbuilt route still 503s with a clear reason.
///      This lets a partial deploy (oracle-only / audit-only) work
///      while a key is being rotated.
///   3. The MCP_AUTH_TOKEN value NEVER touches stdout. The server
///      announces the port and the configured agents — nothing else.
///
/// Endpoints:
///   GET  /health
///   GET  /agents                  (auth required)
///   POST /agents/audit/call       (auth required)
///   POST /agents/oracle/call      (auth required)
///   POST /agents/swap/call        (auth required)

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  inferZG,
  postReceipt,
  type Erc8004Client,
  type GiveFeedbackArgs,
} from '@zhgg/workflow';
import { runAudit, type AuditDeps } from '@zhgg/audit-agent';
import type { SwapClients } from 'swap-agent';
import { createFetchHandler, startServer, type ServerRouteDeps } from './server.js';
import type { RunAuditFn } from './routes/audit.js';

// Re-export so tests can import the handler factory through the package
// barrel. Also keeps the public surface honest — anything not exported
// here is private to the adapter.
export { createFetchHandler };

const AGENT_REGISTRY_GIVE_FEEDBACK_ABI = parseAbi([
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
]);

interface BootEnv {
  authToken: string;
  port: number;
  baseSepoliaPk: Hex | null;
  baseSepoliaRpc: string | null;
  zgPk: Hex | null;
  zgRpc: string | null;
  zgRouterKey: string | null;
  agentRegistry: Address | null;
}

function readBootEnv(env: NodeJS.ProcessEnv = process.env): BootEnv {
  const auth = env.MCP_AUTH_TOKEN ?? '';
  const port = Number(env.MCP_PORT ?? '8080');
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`MCP_PORT must be a positive number, got "${env.MCP_PORT}"`);
  }

  const hex = (key: string, len: number): Hex | null => {
    const v = env[key];
    if (!v) return null;
    if (!new RegExp(`^0x[a-fA-F0-9]{${len}}$`).test(v)) {
      // Bad-format keys are surfaced loudly so a typo doesn't silently
      // disable a route. We DO NOT echo the value itself.
      throw new Error(`env ${key} must be 0x + ${len} hex chars`);
    }
    return v as Hex;
  };
  const addr = (key: string): Address | null => {
    const v = env[key];
    if (!v) return null;
    if (!/^0x[a-fA-F0-9]{40}$/.test(v)) {
      throw new Error(`env ${key} must be a 0x-prefixed 20-byte address`);
    }
    return v as Address;
  };

  return {
    authToken: auth,
    port,
    baseSepoliaPk: hex('BASE_SEPOLIA_PRIVATE_KEY', 64),
    baseSepoliaRpc: env.BASE_SEPOLIA_RPC_URL ?? null,
    zgPk: hex('ZG_PRIVATE_KEY', 64),
    zgRpc: env.ZG_RPC_URL ?? null,
    zgRouterKey: env.ZG_ROUTER_KEY && env.ZG_ROUTER_KEY.length > 0 ? env.ZG_ROUTER_KEY : null,
    agentRegistry: addr('AGENT_REGISTRY_ADDRESS'),
  };
}

/// Build the swap-agent's viem client triple from env. Returns null
/// when any required Base Sepolia env is missing — caller flags the
/// route as unavailable.
function buildSwapClientsOrNull(env: BootEnv): SwapClients | null {
  if (!env.baseSepoliaPk || !env.baseSepoliaRpc) return null;
  const account = privateKeyToAccount(env.baseSepoliaPk);
  const transport = http(env.baseSepoliaRpc);
  const publicClient = createPublicClient({ transport });
  const walletClient = createWalletClient({ account, transport });
  return { publicClient, walletClient, account: account.address };
}

/// Build the audit deps (infer + postReceipt + erc8004 client) from env.
/// Returns null when ZG signer / RPC / registry env is missing.
function buildAuditFnOrNull(env: BootEnv): RunAuditFn | null {
  if (!env.zgPk || !env.zgRpc || !env.agentRegistry) return null;

  const zgAccount = privateKeyToAccount(env.zgPk);
  const zgTransport = http(env.zgRpc);
  const zgPub = createPublicClient({ transport: zgTransport });
  const zgWallet = createWalletClient({ account: zgAccount, transport: zgTransport });
  const registryAddress = env.agentRegistry;

  const erc8004Client: Erc8004Client = {
    giveFeedback: async (args: GiveFeedbackArgs): Promise<Hex> => {
      const sim = await zgPub.simulateContract({
        account: zgAccount,
        address: args.registry,
        abi: AGENT_REGISTRY_GIVE_FEEDBACK_ABI,
        functionName: 'giveFeedback',
        args: [
          args.agentId,
          BigInt(args.value),
          args.valueDecimals,
          args.tag1,
          args.tag2,
          args.endpoint,
          args.feedbackURI,
          args.feedbackHash,
        ],
      });
      const txHash = await zgWallet.writeContract(sim.request);
      await zgPub.waitForTransactionReceipt({ hash: txHash });
      return txHash;
    },
  };

  // Inference requires ZG_ROUTER_KEY. When missing, we still let the
  // adapter boot but the audit route will refuse — surfacing the
  // missing-key fact in the 503 response rather than silently mocking.
  if (!env.zgRouterKey) return null;
  const routerKey = env.zgRouterKey;

  const auditDeps: AuditDeps = {
    infer: (prompt, opts) =>
      inferZG(prompt, { apiKey: opts.apiKey, verifyTee: true }),
    postReceipt,
    erc8004Client,
  };

  return async (target) => {
    return runAudit(target, auditDeps, {
      apiKey: routerKey,
      registryAddress,
      agentRegistryCaip: `eip155:16602:${registryAddress}`,
      clientAddress: `eip155:84532:${zgAccount.address}`,
    });
  };
}

function buildRoutes(env: BootEnv): { routes: ServerRouteDeps; available: string[]; unavailable: Array<{ id: string; reason: string }> } {
  const auditFn = buildAuditFnOrNull(env);
  const swapClients = buildSwapClientsOrNull(env);
  const available: string[] = ['oracle']; // oracle has no env requirement
  const unavailable: Array<{ id: string; reason: string }> = [];

  const auditRouteFn: RunAuditFn = auditFn
    ? auditFn
    : async () => {
        // 503 surfaces as a thrown internal_error in the route handler
        // — concrete reason names which env is missing.
        throw new Error(
          'audit route unavailable: requires ZG_PRIVATE_KEY, ZG_RPC_URL, AGENT_REGISTRY_ADDRESS, ZG_ROUTER_KEY',
        );
      };
  if (auditFn) available.push('audit');
  else
    unavailable.push({
      id: 'audit',
      reason: 'missing one of: ZG_PRIVATE_KEY, ZG_RPC_URL, AGENT_REGISTRY_ADDRESS, ZG_ROUTER_KEY',
    });

  const swapClientsResolved: SwapClients = swapClients ?? {
    // Stub triple — never actually used because the route check fails
    // first. We keep the type satisfied without leaking real keys into
    // a partially-configured deploy.
    publicClient: createPublicClient({ transport: http('http://127.0.0.1:0') }),
    walletClient: createWalletClient({ transport: http('http://127.0.0.1:0') }),
    account: '0x0000000000000000000000000000000000000000',
  };
  const swapExecuteFn = swapClients
    ? undefined
    : async () => {
        return {
          ok: false as const,
          error: {
            kind: 'env_missing' as const,
            reason: 'swap route unavailable: requires BASE_SEPOLIA_PRIVATE_KEY, BASE_SEPOLIA_RPC_URL',
          },
        };
      };
  if (swapClients) available.push('swap');
  else
    unavailable.push({
      id: 'swap',
      reason: 'missing one of: BASE_SEPOLIA_PRIVATE_KEY, BASE_SEPOLIA_RPC_URL',
    });

  return {
    routes: {
      audit: { runAuditFn: auditRouteFn },
      oracle: {},
      swap: { clients: swapClientsResolved, ...(swapExecuteFn ? { executeSwapFn: swapExecuteFn } : {}) },
    },
    available,
    unavailable,
  };
}

async function main(): Promise<void> {
  const env = readBootEnv();
  if (!env.authToken) {
    // CRITICAL: never run an open marketplace endpoint. The .env ships
    // with MCP_AUTH_TOKEN= (empty) so this catches the most common
    // first-run mistake.
    console.error(
      '[zhgg-mcp-adapter] refusing to start: MCP_AUTH_TOKEN is unset.',
    );
    console.error(
      '  set it to a long random string in .env, e.g.:',
    );
    console.error(
      '    MCP_AUTH_TOKEN=$(bun -e "console.log(crypto.randomBytes(32).toString(\\"hex\\"))")',
    );
    process.exit(1);
  }

  const built = buildRoutes(env);

  const { server, port } = startServer({
    port: env.port,
    authToken: env.authToken,
    routes: built.routes,
  });

  console.log(
    `[zhgg-mcp-adapter] listening on http://localhost:${port} (auth: bearer)`,
  );
  console.log(
    `[zhgg-mcp-adapter] available agents: ${built.available.join(', ') || '(none)'}`,
  );
  for (const u of built.unavailable) {
    console.log(`[zhgg-mcp-adapter] agent "${u.id}" unavailable — ${u.reason}`);
  }

  // Reference `server` so the GC doesn't reclaim it; Bun.serve already
  // keeps the loop alive but TypeScript flags an unused let otherwise.
  void server;
}

if (import.meta.main) {
  void main();
}
