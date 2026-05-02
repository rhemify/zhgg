/// JSON Schema descriptors for the three zhgg agents exposed to KeeperHub.
///
/// KH `HTTP Action` nodes consume the marketplace listing shape:
///   { id, name, description, inputSchema, priceUsdcPerCall }
/// The `inputSchema` is plain JSON Schema (draft-07 subset) — KH renders
/// the form, validates client-side, and posts the typed body back to the
/// `/agents/{id}/call` endpoint. We mirror the schema here in TypeScript
/// so the route handlers can run the same validation server-side without
/// pulling in a JSON Schema library.

export interface AgentDescriptor {
  id: 'audit' | 'oracle' | 'swap';
  name: string;
  description: string;
  /// JSON Schema (draft-07 subset). KH's marketplace UI consumes this
  /// shape directly — keep it portable: only `type`, `properties`,
  /// `required`, `enum`, `description`.
  inputSchema: {
    type: 'object';
    properties: Record<string, JsonSchemaProp>;
    required: string[];
    additionalProperties: boolean;
  };
  priceUsdcPerCall: string;
}

export interface JsonSchemaProp {
  type: 'string' | 'number' | 'boolean';
  description?: string;
  enum?: readonly string[];
}

export const AGENTS: readonly AgentDescriptor[] = [
  {
    id: 'audit',
    name: 'audit.zhgg.eth',
    description:
      'EU AI Act compliance auditor. Probes a target agent against ' +
      'Articles 5, 13, and 50 of Regulation (EU) 2024/1689 and posts an ' +
      'ERC-8004 reputation receipt. Returns the AuditReport JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description:
            'Target agent token id (decimal string — converted to bigint server-side).',
        },
        agentName: {
          type: 'string',
          description: 'Target agent name (e.g. "oracle.zhgg.eth").',
        },
        manifest: {
          type: 'string',
          description:
            'Free-form capability manifest fed into each probe prompt.',
        },
      },
      required: ['agentId', 'agentName', 'manifest'],
      additionalProperties: false,
    },
    priceUsdcPerCall: '0.10',
  },
  {
    id: 'oracle',
    name: 'oracle.zhgg.eth',
    description:
      'Regulatory + price oracle. Topics: eu-ai-act, mica, gdpr-ai (canned ' +
      'regulatory deltas) or price (live Pyth Hermes pull-oracle quote). ' +
      'For price queries, supply { topic: "price", symbol: "ETH/USD" }.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Oracle topic.',
          enum: ['eu-ai-act', 'mica', 'gdpr-ai', 'price'],
        },
        symbol: {
          type: 'string',
          description:
            'Optional — symbol for price topic (e.g. "ETH/USD"). Ignored ' +
            'for regulatory topics.',
        },
      },
      required: ['topic'],
      additionalProperties: false,
    },
    priceUsdcPerCall: '0.01',
  },
  {
    id: 'swap',
    name: 'swap.zhgg.eth',
    description:
      'Real Uniswap V3 swap on Base Sepolia. Supports ETH/WETH/USDC. ' +
      'ETH ↔ WETH routes through WETH9.deposit/withdraw; everything else ' +
      'goes through SwapRouter02.exactInputSingle. Returns the real txHash.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: {
          type: 'string',
          description:
            'Decimal amount string (e.g. "0.001" for 0.001 ETH, "5" for 5 USDC).',
        },
        from: {
          type: 'string',
          description: 'Source symbol.',
          enum: ['ETH', 'WETH', 'USDC'],
        },
        to: {
          type: 'string',
          description: 'Destination symbol.',
          enum: ['ETH', 'WETH', 'USDC'],
        },
      },
      required: ['amount', 'from', 'to'],
      additionalProperties: false,
    },
    priceUsdcPerCall: '0.05',
  },
] as const;

/// Validate `body` against an agent's inputSchema. Returns the first
/// missing required key (or the offending key + reason for type/enum
/// mismatches), or `null` when the body is valid.
///
/// Deliberately small — we only validate what KH's form will produce. A
/// production deploy should swap in `ajv` or `zod`, but pulling either
/// just for three agents is overkill and fights `verbatimModuleSyntax`.
export function validateAgentInput(
  body: unknown,
  schema: AgentDescriptor['inputSchema'],
): { ok: true } | { ok: false; missing?: string; key?: string; reason: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: 'body_not_object' };
  }
  const obj = body as Record<string, unknown>;

  for (const required of schema.required) {
    if (!(required in obj) || obj[required] === undefined || obj[required] === null) {
      return { ok: false, missing: required, reason: `missing required key: ${required}` };
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    const prop = schema.properties[key];
    if (!prop) {
      if (!schema.additionalProperties) {
        return { ok: false, key, reason: `unexpected key: ${key}` };
      }
      continue;
    }
    if (prop.type === 'string' && typeof value !== 'string') {
      return { ok: false, key, reason: `key ${key} must be string` };
    }
    if (prop.type === 'number' && typeof value !== 'number') {
      return { ok: false, key, reason: `key ${key} must be number` };
    }
    if (prop.type === 'boolean' && typeof value !== 'boolean') {
      return { ok: false, key, reason: `key ${key} must be boolean` };
    }
    if (prop.enum && typeof value === 'string' && !prop.enum.includes(value)) {
      return {
        ok: false,
        key,
        reason: `key ${key} must be one of: ${prop.enum.join(', ')}`,
      };
    }
  }
  return { ok: true };
}
