# KeeperHub ops + integration surfaces (agent 4, complete)

Source: `KeeperHub/keeperhub` GitHub `staging` branch (forked from `vercel-labs/workflow-builder-template`).
Self-description: no-code blockchain automation, visual workflow builder.
Supported chains (FAQ): EVM only — Ethereum, Base, Arbitrum, Polygon, Optimism, Sepolia. Solana / Cosmos / Bitcoin L2 NOT supported.
Note: 0G chain NOT in current `staging` docs. PR #1046 (mentioned earlier) hasn't merged into the doc surface this agent saw.

## Run lifecycle ("execution" in API, "run" in UI — same thing)

State machine (verbatim from `docs/api/executions.md`):
```
| Status      | Description                |
|-------------|----------------------------|
| pending     | Execution queued           |
| running     | Currently executing        |
| success     | Completed successfully     |
| error       | Failed with error          |
| cancelled   | Manually cancelled         |
```

Per-node sub-states via `GET /api/workflows/executions/{executionId}/status`:
```json
{
  "status": "running",
  "nodeStatuses": [
    { "nodeId": "node_1", "status": "success" },
    { "nodeId": "node_2", "status": "running" }
  ],
  "progress": { "totalSteps": 3, "completedSteps": 1, "runningSteps": 1, "currentNodeId": "node_2", "percentage": 33 }
}
```

Failed steps retry with exponential backoff (FAQ).

## Webhook / event surface

**KH webhooks are INBOUND only — NO outbound webhook on run completion.**

1. `POST /api/workflows/{id}/webhook` — inbound trigger; external systems start a run with API key auth. Returns `{status: "pending"}`.
2. Integrations of `type: "webhook"` — outbound HTTP node a workflow author drops INTO the DAG; only fires when DAG reaches it.
3. `GET /api/analytics/stream` — SSE feed, org-level summary every 2s. Aggregate only, not per-run completion events.

**Polling fallback** for "did it succeed?":
- `GET /api/workflows/executions/{executionId}/status` (mid-run)
- `GET /api/workflows/executions/{executionId}/logs` (post-run)
- `GET /api/analytics/runs?status=success&range=24h&cursor=...` (newest-first global feed)

## Integrations API

Supported types (verbatim):
```
| Type         | Description                          |
|--------------|--------------------------------------|
| discord      | Discord webhook notifications        |
| slack        | Slack workspace integration          |
| telegram     | Telegram bot messaging               |
| sendgrid     | Email via SendGrid                   |
| resend       | Email via Resend                     |
| safe         | Safe multisig API integration        |
| webhook      | Custom HTTP webhooks                 |
| web3         | Web3 wallet connections              |
| ai-gateway   | AI service integrations              |
```

CRUD: `GET/POST/PUT/DELETE /api/integrations[/{id}]` + `POST /api/integrations/{id}/test`.
Body: `{ "name", "type", "config": {...} }`. Static config (no OAuth). `config` excluded from list responses.

**Cannot register a "payment callback" integration.** Only the 9 types above. No platform-level "fire on every run" hook.

DeFi plugins: Aave V3, Morpho, Uniswap, CoW Swap, Pendle, Sky, Ajna, Safe, generic Web3.

## Analytics API

```
GET /api/analytics/summary
GET /api/analytics/time-series
GET /api/analytics/networks
GET /api/analytics/runs
GET /api/analytics/runs/{executionId}/steps
GET /api/analytics/spend-cap
GET /api/analytics/stream    (SSE)
```

All accept `range` (`24h | 7d | 30d | 90d | custom`) + `customStart` / `customEnd`.

Summary response (verbatim):
```json
{ "totalRuns": 1250, "successfulRuns": 1180, "failedRuns": 70,
  "successRate": 94.4, "totalGasUsedWei": "1500000000000000000",
  "avgExecutionTimeMs": 2340 }
```

`GET /api/analytics/runs` query: `range`, `customStart`, `customEnd`, `status` (`pending|running|success|error`), `source` (`workflow|direct`), `limit`, `cursor`. Response: `id, source, workflowId, workflowName, status, createdAt, completedAt, durationMs`, plus `gasUsedWei / transactionHash / network` for `source:"direct"`.

Spend-cap:
```json
{ "dailyCapWei": "1000000000000000000", "spentTodayWei": "250000000000000000",
  "remainingWei": "750000000000000000", "percentUsed": 25.0 }
```

✅ Per-workflow / per-author: run count, success/fail counts, gas, network breakdown, latency
❌ NO billing volume metric, no `?author=` query, no p50/p99 percentiles

## CRITICAL: Direct-API path billing reconciliation

This agent grepped repo-wide for `billing|payment|stripe|subscription|pricing|credit|plan` and found ZERO hits in the direct API surface (`/api/workflows/...`, `/api/integrations/...`, `/api/analytics/...`). What users pay TODAY on the **direct API path**:
- ETH gas via their own Para MPC wallet
- Para Inc indirectly (MPC infra)
- KeeperHub: NOTHING (per FAQ + repo grep)

**This agent missed `docs/workflows/marketplace.md`** which agent 2 confirmed exists with explicit billing: marketplace path takes 30% KH / 70% author. The two paths are billed differently:

| Path | Billing |
|---|---|
| `POST /api/workflow/{wf_id}/execute` (direct API) | Caller pays gas. KH free. |
| `POST /api/workflows/{id}/webhook` (webhook trigger) | Caller pays gas. KH free. |
| `/api/mcp/workflows/<slug>/call` (marketplace MCP) | Caller pays USDC. KH 30%. Author 70%. |

## Hooks zhgg can use for 85/5/5/5

**Option A — webhook-action node in every paid workflow (works today)**:
Publish a "zhgg-fee-splitter" plugin node. Workflow author drops it as the first node in their marketplace listing. When the run starts, the node calls `FeeSplitter.splitERC20()` from the author's Para wallet (after marketplace settled the 70% author cut). Pros: zero KH infra changes. Cons: author can omit it; not enforced platform-side.

**Option B — outbound `run.completed` webhook (requires upstream PR)**:
Propose new integration `type: "payment-callback"` that fires on terminal `success`. Payload: `{event, executionId, runId, workflowId, workflowAuthorId, status, durationMs, gasUsedWei, completedAt}`, signed. zhgg listener triggers FeeSplitter. Stripe-style hook. Long-term right path.

**Option C — polling shim (works today)**:
zhgg backend polls `GET /api/analytics/runs?status=success&range=custom&customStart=<lastCursor>` per org API key, dedupes by `executionId`, fires FeeSplitter per new completion. Requires zhgg-side escrow.

**Recommended**: A (immediately) + B (PR upstream) for the marketplace path.

## Source URLs

- https://github.com/KeeperHub/keeperhub/blob/staging/docs/keeper-runs/troubleshooting.md
- https://github.com/KeeperHub/keeperhub/blob/staging/docs/keeper-runs/overview.md
- https://github.com/KeeperHub/keeperhub/blob/staging/docs/keeper-runs/status-logs.md
- https://github.com/KeeperHub/keeperhub/blob/staging/docs/keeper-runs/monitoring.md
- https://github.com/KeeperHub/keeperhub/blob/staging/docs/api/integrations.md
- https://github.com/KeeperHub/keeperhub/blob/staging/docs/api/analytics.md
- https://github.com/KeeperHub/keeperhub/blob/staging/docs/api/executions.md
- https://github.com/KeeperHub/keeperhub/blob/staging/docs/api/workflows.md
- https://github.com/KeeperHub/keeperhub/blob/staging/docs/FAQ.md
