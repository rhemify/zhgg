# KeeperHub GitHub org sweep (agent 1, complete)

Last fetched: 2026-04-30 via `gh api orgs/KeeperHub/repos`.
Total repos: **7** (1 main monorepo, 1 archived, 5 active satellites).

## Top 3 most relevant for zhgg

### 1. `KeeperHub/agentic-wallet` (npm `@keeperhub/wallet`)
- TypeScript, default branch `main`, last push 2026-04-29
- **The payment client zhgg should reuse**
- Speaks canonical `/api/mcp/workflows/<slug>/call` 402 protocol
- Two rails: x402 on Base USDC + MPP on Tempo USDC.e
- Key files:
  - `src/payment-signer.ts` — `pay()` / `fetch()` API
  - `src/workflow-slug.ts` — slug regex `/\/api\/mcp\/workflows\/([a-zA-Z0-9_-]+)\/call/`
  - `src/x402-detect.ts`, `src/mpp-detect.ts`
  - `src/chains.ts` — Base 8453 USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, Tempo 4217 USDC.e `0x20c000000000000000000000b9537d11c60e8b50`
  - `src/types.ts` — `WalletConfig = { subOrgId, walletAddress, hmacSecret }` (Turnkey-custodied, server-side)

### 2. `KeeperHub/cli` (Go, `main`, last push 2026-04-23)
- Canonical REST surface for workflows
- `cmd/workflow/run.go`: `POST /api/workflow/<id>/execute` → `{executionId, status}`, poll `GET /api/workflows/executions/<execId>/status`
- `cmd/billing/{status,usage}.go`: `GET /api/billing/subscription` → `{Subscription{Plan,Status}, Usage{Executions,Limit}, OverageCharges}`
- `cmd/execute/contract_call.go`: `POST /api/execute/contract-call`
- `cmd/wallet/agentic_wrapper.go` — shells out to `npx @keeperhub/wallet`
- MCP recommended via remote HTTP at `https://app.keeperhub.com/mcp`; local stdio mode deprecated

### 3. `KeeperHub/claude-plugins`
- Marketplace of one plugin with 4 skills: workflow-builder, template-browser, execution-monitor, plugin-explorer
- Connects to remote MCP via OAuth
- UX reference only, not a runtime

## Skip
- `mcp` — archived, merged into `keeperhub`
- `homebrew-tap` — no README
- `agentic-wallet-skills` — skill mirror, no code

## CRITICAL FINDING: where does the workflow author get paid?

**Today: nowhere on-chain in any KeeperHub repo.**

Settlement is centralized:
1. Every paid call hits `app.keeperhub.com`'s `/api/mcp/workflows/<slug>/call`
2. Server emits 402
3. agentic-wallet signs via `POST /api/agentic-wallet/sign` (Turnkey custody)
4. Server "verifies payTo + amount against the workflows registry" (per source comment)
5. Actual `payTo` per slug and any author-payout/split logic lives server-side in `keeperhub` monorepo's `lib/payments/router.ts` — NOT exposed via the API

**End-user billing is subscription-based** (`/api/billing/subscription` returns plan/usage/overage in dollars). There is no per-call revenue share, no FeeSplitter address, no ERC-8004 reputation, no iNFT references anywhere across all 7 repos.

## Implication for zhgg

The "85/5/5/5 FeeSplitter + ERC-8004 + iNFT" layer is a **real gap, not a duplicate**.

**Clean integration point: the workflow slug.**
- zhgg's iNFT metadata stores the KeeperHub `<slug>` (matching `[a-zA-Z0-9_-]+`)
- KeeperHub registry stays single source of truth for the workflow definition + 402 protocol
- zhgg becomes the on-chain settlement layer that fires **AFTER** a successful `/api/mcp/workflows/<slug>/call`
- Workflow's author iNFT receives the 85% on FeeSplitter
