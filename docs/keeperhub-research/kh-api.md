# KeeperHub API surface (agent 3, complete)

## Two-key auth model (STRICT)

| Key prefix | Scope | Use |
|---|---|---|
| `kh_` | org-level | REST + direct exec |
| `wfb_` | user-level | webhook trigger ONLY, rejects on REST |

Cross-member `wfb_` use returns 403.

## Three trigger paths — comparison

### 1. Direct Execution API (no saved workflow)
```
POST /api/execute/{transfer | contract-call | check-and-execute}
Authorization: Bearer kh_...
```
- **Sync HTTP**: returns `{executionId, status: "completed"|"failed"}` inline
- Response does NOT include `transactionHash`, `gasUsedWei`, `result`/`error`
- For details: `GET /api/execute/{executionId}/status`
- Spending cap: org-level daily wei limit. Returns `422 SPENDING_CAP_EXCEEDED`
- NO x402 surface

### 2. Saved workflow trigger
```
POST /api/workflow/{workflowId}/execute
Authorization: Bearer kh_...
```
- **Async**: returns `status: "pending"`
- Poll `/api/workflows/executions/{executionId}/status`
- NO x402

### 3. Webhook trigger
```
POST /api/workflows/{workflowId}/webhook
Authorization: Bearer wfb_...
```
- Requires user key bound to workflow owner
- NO x402

### 4. Marketplace MCP call (x402 PAID)
```
GET https://app.keeperhub.com/api/mcp/workflows/<slug>/call
```
- Returns 402 with `paymentRequirements`
- Caller signs x402 (Base USDC) or MPP (Tempo USDC.e)
- KH facilitator settles: 30% KH, 70% author wallet
- This is THE paid execution path

## Status enum drift (don't unify)

```
Workflow executions: pending | running | success | error | cancelled
Direct executions:   completed | failed
```

Aliasing required if normalizing in Zod / TypeScript types.

## Wire format gotchas

- `functionArgs` and `abi` on `/api/execute/contract-call` are **JSON-encoded strings**, not raw arrays/objects
- Marketplace search has NO author/freetext query — only `featured`, `featuredProtocol`, `tag` (slug)
- Discover slugs via `GET /api/workflows/taxonomy`
- Key minting (`POST /api/keys`) is **session-only** — can't bootstrap new `kh_` from existing `kh_`. Rotation: mint new, revoke old (non-atomic).
- "Project" = folder/label inside org. NOT a billing unit. Spending caps live on the organization.
