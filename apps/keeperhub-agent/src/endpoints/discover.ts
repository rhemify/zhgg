/// `GET /api/mcp/workflows` — MCP-callable marketplace discovery.
///
/// Returns the catalog of workflows orgs have listed AS MCP-callable —
/// i.e. discoverable AND invokable via slug-based x402 calls at
/// `/api/mcp/workflows/<slug>/call`. Each entry carries the full
/// `inputSchema` JSON Schema, `priceUsdcPerCall` for x402 pricing, and
/// metadata (`category`, `chain`, `workflowType`) for client-side
/// filtering.
///
/// This is the discovery rail that makes the marketplace ACTIONABLE
/// from inside an agent: an iNFT can list available services, pick one
/// matching its capability gap, and (in a future step) `kh hire <wfId>`
/// to pay-and-trigger via the existing x402 path.
///
/// IMPORTANT — two distinct endpoints exist (probed live 2026-05-02):
///   - `/api/mcp/workflows`     27 entries, MCP-callable (this helper)
///   - `/api/workflows/public`  85 entries, all public-readable (broader)
///
/// The MCP set is the right surface for "agents hiring agents" because
/// callability is the MVP — a workflow that's public-readable but not
/// MCP-exposed can be inspected but not paid-and-invoked. If you ever
/// want the broader 85, layer a new helper rather than overloading this.
///
/// PAGINATION — server returns `{items, total, page, limit}` with a
/// default limit of 20. We pass `?limit=100` so all current entries
/// arrive in one request; revisit if KH starts paginating past 100.

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
  /// Limit returned entries (after filter). Defaults to 100 — large
  /// enough to surface the entire current catalog (~27) without
  /// truncation. Pass an explicit smaller value if you only want the
  /// top N for a TUI render.
  limit?: number;
}

export async function discoverWorkflows(
  client: KHClient,
  filters: DiscoverFilters = {},
): Promise<KHResult<KHPublicWorkflow[]>> {
  // ?limit=100 — server default is 20; current catalog has 27 total so
  // 100 fetches everything in one shot. If the catalog ever exceeds
  // 100, we'd switch to a multi-page loop using the `total` + `page`
  // fields the server returns alongside `items`.
  const r = await client.get<unknown>('/api/mcp/workflows?limit=100');
  if (!r.ok) return r;
  // Endpoint returns `{items, total, page, limit}` — defend against
  // shape drift but lean on the documented shape.
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
  const limit = filters.limit ?? 100;
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
  const q = workflowId.toLowerCase();
  const found =
    r.value.find((w) => w.id === workflowId) ??
    r.value.find((w) => (w.listedSlug ?? '').toLowerCase() === q) ??
    null;
  return { ok: true, value: found };
}
