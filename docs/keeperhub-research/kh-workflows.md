# KeeperHub workflow lifecycle (agent 2, complete)

Sources fetched 2026-04-29 from `KeeperHub/keeperhub` branch `staging`:
`docs/workflows/{marketplace,hub,import-export,creating,index}.md` + `docs/api/workflows.md`.

## Workflow ID — DUAL surface

1. **Internal API ID**: `wf_<id>` (e.g. `wf_123`). Sibling prefixes: `proj_`, `tag_`, `exec_`, `run_`. Used by all `/api/workflows/...` endpoints.
2. **Marketplace slug** — permanent, lowercase + hyphens only, **flat** (NOT `@user/name` namespaced). Examples in docs: `aave-v3-health-check`, `eth-balance`, `stablecoin-yield-rates`, **`mcp-test`** (live, queryable today, $0.01/call). Public URL: `https://app.keeperhub.com/api/mcp/workflows/<slug>/call`

## Workflow definition (JSON)

Export schema — 6 top-level keys, verbatim:
- `version` (currently `1`)
- `exportedAt` (ISO timestamp, informational)
- `workflow` (`name` + `description`)
- `nodes` (each: `id`, `type`, `position`, `data`)
- `edges` (`source`/`target` by id; conditional branches use `sourceHandle: "true"|"false"`)
- `integrationBindings`

Node configs namespaced: `web3/check-balance`, `web3/write-contract`, `webhook/send-webhook`, `Condition`.
Field references: `{{@nodeId:Label.field}}`.
Minimum viable export: 2 nodes + 1 edge.

## Marketplace billing — FIXED model

Verbatim: "Every call to your listed workflow generates revenue. KeeperHub takes a 30% platform fee. You receive 70%."

- Caller pays per call in USDC
- Author sets price ($0.001–$0.10 typical)
- **KeeperHub: 30% fixed | author: 70%**
- Two rails: x402 on Base USDC + MPP on Tempo (chain 4217, USDC.e)
- Funds land **directly in author's org creator wallet** on whichever chain caller paid
- KeeperHub does NOT auto-bridge
- Callers charged only on successful execution
- KH already registered as ERC-8004 service provider on x402scan + mppscan

## Hub vs Marketplace (distinct surfaces)

| | Hub | Marketplace |
|---|---|---|
| What | Free template directory | Paid black-box endpoints |
| User action | Duplicate template into own account | Send inputs + payment, get output |
| Runs in | User's own org | Author's org (with author's credentials/credits) |
| Credentials | Cleared on duplicate | Stay private to author |

## Import/export

- Workflows fully exportable as JSON: `<workflow-slug>.workflow.json`
- API: `GET /api/workflows/{workflowId}/download`
- Re-import via Hub upload UI creates private copy with bindings reset
- KeeperHub explicitly endorses git version control: "Commit the JSON to git, review changes in PRs."
- **CAN ship `.workflow.json` files in a zhgg plugin folder**

## Creation paths (4)

1. Visual web builder
2. MCP `create_workflow`
3. Claude Code plugin
4. `kh` CLI

Triggers: `Scheduled` / `Webhook` / `Event` / `Manual`. **Marketplace listings require Manual** so caller inputs flow through.

Action categories:
- Web3 (Check Balance, Read/Write Contract, Transfer, Approve)
- Notifications (Email/Discord/Slack)
- Integrations (Webhook, custom HTTP)

Condition operators: `==`, `===`, `!=`, `!==`, `<`, `<=`, `>`, `>=`, `contains`, `startsWith`, `endsWith`, `matchesRegex`, `isEmpty`, `isNotEmpty`, `exists`, `doesNotExist` + arithmetic (`+ - * / % **`) in expression mode.

Marketplace listing manifest minimum: slug + USDC price + input schema (per-field `{type, description}` where `type ∈ string|number|boolean`) + output schema (pick fields from downstream node) + active toggle.

## Implication for zhgg's 85/5/5/5

KH's 30% cut is **hard-coded** — we can't intercept it. Two options:

**Option A (real, uses KH marketplace):**
- Author EOA receives KH's 70% directly
- That EOA immediately splits via our FeeSplitter
- Effective: ~59.5% owner / ~3.5% keeper / ~3.5% zhgg / ~3.5% commons (after KH's 30%)
- The "85/5/5/5" describes our own split of *what we receive*

**Option B (bypass marketplace):**
- POST /api/workflow/{wf_id}/execute (API-key auth)
- Runs on OUR org credits, no KH fee, no caller payment rail
- We run x402 ourselves, route 100% through FeeSplitter
- Loses "real KH integration" narrative

**Recommendation: Option A** — uses KH's actual payment rail (their x402 + MPP), splits the 70% author cut on Base. Honest about KH's 30%.
