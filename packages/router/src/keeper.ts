import type { Result } from './result.js';
import { loadEnv } from './constants.js';
import { appendFee } from './erc8021.js';

export interface SettleParams {
  tx: string;
  chain: number;
  maxRetries?: number;
}

export interface SettleResult {
  txHash: string;
  confirmed: boolean;
}

export type KeeperError =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'transport'; reason: string }
  | { kind: 'malformed_response'; reason: string }
  | { kind: 'settlement_failed'; reason: string };

export interface KeeperClient {
  settle(params: SettleParams): Promise<Result<SettleResult, KeeperError>>;
  close(): Promise<void>;
}

export interface McpLikeClient {
  callTool(req: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<{
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }>;
  close(): Promise<void>;
}

export interface KeeperOptions {
  endpoint?: string;
  toolName?: string;
  requestMapper?: (params: SettleParams) => Record<string, unknown>;
  clientName?: string;
  clientVersion?: string;
  /**
   * When true (default), the default requestMapper appends an ERC-8021 fee
   * suffix to `tx` before sending it to the keeper. Setting this to false
   * skips the protocol fee mechanism entirely — only use for tests or when
   * the caller has already attached a suffix.
   */
  attachFee?: boolean;
}

const DEFAULT_TOOL_NAME = 'settle';
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_CLIENT_NAME = 'zhgg-router';
const DEFAULT_CLIENT_VERSION = '1.0.0';

const buildDefaultRequestMapper =
  (attachFee: boolean) =>
  (p: SettleParams): Record<string, unknown> => ({
    tx: attachFee ? appendFee(p.tx) : p.tx,
    chain: p.chain,
    maxRetries: p.maxRetries ?? DEFAULT_MAX_RETRIES,
  });

function joinTextContent(
  content: Array<{ type: string; text?: string }> | undefined,
): string {
  if (!content || content.length === 0) return '';
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text ?? '')
    .join('\n');
}

export function createKeeperFromMcpClient(
  client: McpLikeClient,
  opts?: {
    toolName?: string;
    requestMapper?: KeeperOptions['requestMapper'];
    attachFee?: boolean;
  },
): KeeperClient {
  const toolName = opts?.toolName ?? DEFAULT_TOOL_NAME;
  const attachFee = opts?.attachFee ?? true;
  const requestMapper =
    opts?.requestMapper ?? buildDefaultRequestMapper(attachFee);

  return {
    async settle(
      params: SettleParams,
    ): Promise<Result<SettleResult, KeeperError>> {
      const args = requestMapper(params);

      let raw: Awaited<ReturnType<McpLikeClient['callTool']>>;
      try {
        raw = await client.callTool({ name: toolName, arguments: args });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { kind: 'transport', reason } };
      }

      if (raw.isError === true) {
        const reason = joinTextContent(raw.content) || 'mcp returned isError';
        return { ok: false, error: { kind: 'transport', reason } };
      }

      const first = raw.content?.[0];
      if (!first) {
        return {
          ok: false,
          error: {
            kind: 'malformed_response',
            reason: 'empty content array',
          },
        };
      }
      if (first.type !== 'text') {
        return {
          ok: false,
          error: {
            kind: 'malformed_response',
            reason: `expected text content, got ${first.type}`,
          },
        };
      }
      const text = first.text;
      if (typeof text !== 'string' || text.length === 0) {
        return {
          ok: false,
          error: {
            kind: 'malformed_response',
            reason: 'empty text content',
          },
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: {
            kind: 'malformed_response',
            reason: `invalid JSON: ${reason}`,
          },
        };
      }

      if (typeof parsed !== 'object' || parsed === null) {
        return {
          ok: false,
          error: {
            kind: 'malformed_response',
            reason: 'response is not an object',
          },
        };
      }
      const obj = parsed as Record<string, unknown>;
      const txHash = obj.txHash;
      const confirmed = obj.confirmed;
      if (typeof txHash !== 'string' || txHash.length === 0) {
        return {
          ok: false,
          error: {
            kind: 'malformed_response',
            reason: 'missing or invalid txHash',
          },
        };
      }
      if (typeof confirmed !== 'boolean') {
        return {
          ok: false,
          error: {
            kind: 'malformed_response',
            reason: 'missing or invalid confirmed',
          },
        };
      }

      if (confirmed === false) {
        return {
          ok: false,
          error: {
            kind: 'settlement_failed',
            reason: `${txHash} unconfirmed`,
          },
        };
      }

      return { ok: true, value: { txHash, confirmed: true } };
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
}

export async function createKeeperClient(
  opts: KeeperOptions = {},
): Promise<KeeperClient> {
  const endpoint = opts.endpoint ?? loadEnv().KEEPERHUB_MCP_ENDPOINT;
  const clientName = opts.clientName ?? DEFAULT_CLIENT_NAME;
  const clientVersion = opts.clientVersion ?? DEFAULT_CLIENT_VERSION;

  let ClientCtor: typeof import('@modelcontextprotocol/sdk/client/index.js').Client;
  let TransportCtor: typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport;
  try {
    const clientMod = await import('@modelcontextprotocol/sdk/client/index.js');
    const transportMod = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );
    ClientCtor = clientMod.Client;
    TransportCtor = transportMod.StreamableHTTPClientTransport;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const e: KeeperError = {
      kind: 'unavailable',
      reason: `failed to load MCP SDK: ${reason}`,
    };
    throw new Error(JSON.stringify(e));
  }

  const sdkClient = new ClientCtor({ name: clientName, version: clientVersion });
  const transport = new TransportCtor(new URL(endpoint));
  try {
    await sdkClient.connect(transport);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const e: KeeperError = {
      kind: 'unavailable',
      reason: `failed to connect to ${endpoint}: ${reason}`,
    };
    throw new Error(JSON.stringify(e));
  }

  const adapter: McpLikeClient = {
    async callTool(req) {
      const out = (await sdkClient.callTool(req)) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      return out;
    },
    async close() {
      await sdkClient.close();
    },
  };

  return createKeeperFromMcpClient(adapter, {
    toolName: opts.toolName,
    requestMapper: opts.requestMapper,
    attachFee: opts.attachFee,
  });
}
