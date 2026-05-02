/// `GET /api/mcp/workflows` — public marketplace discovery.
///
/// Returns the catalog of workflows other orgs have listed publicly
/// (`isListed=true` on their side). Each entry carries the full
/// `inputSchema` JSON Schema, `priceUsdcPerCall` for x402 pricing, and
/// metadata (`category`, `chain`, `workflowType`) for client-side
/// filtering. As of 2026-05-02 the live deployment returns ~85 entries
/// covering ARYA, Open Deal, Aave V3, Ajna, etc.
///
/// This is the discovery rail that makes the marketplace ACTIONABLE
/// from inside an agent: an iNFT can list available services, pick one
/// matching its capability gap, and (in a future step) `kh hire <wfId>`
/// to pay-and-trigger via the existing x402 path.
///
/// We intentionally do NOT also wrap `/api/workflows/public` — both
/// endpoints return overlapping data, but the `/api/mcp/workflows` shape
/// is leaner (no full DAG `nodes` blob) and pre-shaped for MCP use.
/// If a future use case needs the full node graph, layer a separate
/// helper instead of overloading this one.

import type { KHClient } from '../client.js';
import type { KHResult } from '../index.js';

/// Lean public listing — what `/api/mcp/workflows` items array gives us.
/// Heavy fields like the DAG `nodes` are absent here; the `inputSchema`
/// is what callers actually need to know what params a workflow expects.
export interface KHPublicWorkflow {
  id: string;
  name: string;
  description: string;
  /// Marketplace slug for x402 calls (`/api/mcp/workflows/<slug>/call`).
  /// Null when the org has listed via `isListed=true` but not assigned
  /// a public slug yet — those workflows are still discoverable but not
  /// callable via slug-based x402.
  listedSlug: string | null;
  listedAt: string | null;
  /// JSON Schema describing required + optional params. Agents pull
  /// this to know what to feed `kh hire`. Keep loose — KH may add
  /// fields we don't model yet.
  inputSchema?: {
    type?: string;
    required?: string[];
    properties?: Record<string, unknown>;
    additionalProperties?: boolean;
    [extra: string]: unknown;
  };
  outputMapping?: unknown;
  /// Price per call in USDC, paid via x402. Null when free / not yet
  /// priced. Decimal-string when set (e.g. "0.5" for 0.50 USDC).
  priceUsdcPerCall: string | null;
  organizationId: string;
  createdAt: string;
  updatedAt: string;
  isListed: boolean;
  /// Loose type tags KH attaches: "read" / "write" / "monitor" / etc.
  workflowType?: string | null;
  category?: string | null;
  chain?: string | null;
  [extra: string]: unknown;
}

/// Filter options applied client-side after fetching the full list.
/// KH's endpoint doesn't expose query params for these as of probe, so
/// we paginate locally — pulls all 85 then narrows. At current size
/// that's a single small response (≈80KB); revisit if the catalog
/// grows past a few hundred.
export interface DiscoverFilters {
  /// Case-insensitive substring match against `name` + `description`.
  /// Empty/undefined → no filter.
  search?: string;
  /// Exact-match against `category`. Useful once KH starts populating it.
  category?: string;
  /// Exact-match against `chain` (e.g. "0g-galileo", "base-sepolia").
  chain?: string;
  /// Limit returned entries (after filter). Defaults to 25.
  limit?: number;
}

export async function discoverWorkflows(
  client: KHClient,
  filters: DiscoverFilters = {},
): Promise<KHResult<KHPublicWorkflow[]>> {
  const r = await client.get<unknown>('/api/mcp/workflows');
  if (!r.ok) return r;
  // Endpoint returns `{items: [...]}` — defend against shape drift.
  const body = r.value;
  let items: unknown;
  if (Array.isArray(body)) {
    items = body;
  } else if (body !== null && typeof body === 'object' && 'items' in body) {
    items = (body as { items: unknown }).items;
  } else {
    return {
      ok: false,
      error: {
        kind: 'malformed_response',
        reason: `expected array or {items:[]}, got ${typeof body}`,
      },
    };
  }
  if (!Array.isArray(items)) {
    return {
      ok: false,
      error: { kind: 'malformed_response', reason: '`items` is not an array' },
    };
  }

  let workflows = items as KHPublicWorkflow[];
  if (filters.search) {
    const q = filters.search.toLowerCase();
    workflows = workflows.filter(
      (w) =>
        (w.name ?? '').toLowerCase().includes(q) ||
        (w.description ?? '').toLowerCase().includes(q),
    );
  }
  if (filters.category) {
    workflows = workflows.filter((w) => w.category === filters.category);
  }
  if (filters.chain) {
    workflows = workflows.filter((w) => w.chain === filters.chain);
  }
  const limit = filters.limit ?? 25;
  return { ok: true, value: workflows.slice(0, limit) };
}

/// Single-workflow inspection — fetch the full public catalog, then
/// narrow to one id. KH doesn't appear to expose `/api/mcp/workflows/{id}`
/// directly (the slug-based path is for x402 calls, not metadata reads).
/// Falling out of the catalog is fine: 85 entries are < 100KB and we
/// only `inspect` interactively.
export async function inspectWorkflow(
  client: KHClient,
  workflowId: string,
): Promise<KHResult<KHPublicWorkflow | null>> {
  const r = await discoverWorkflows(client, { limit: 10_000 });
  if (!r.ok) return r;
  const found = r.value.find((w) => w.id === workflowId) ?? null;
  return { ok: true, value: found };
}
