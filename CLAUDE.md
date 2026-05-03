## Important notes:
- Use bun
- Use threejs fibre for 3D animation

## Live audit pipeline — gotchas the team should know

> Context: `bun run apps/demo/src/index.ts audit oracle --live` exercises the full end-to-end audit (settlement → AxiomCommit → Qwen probes → 0G Storage → ERC-8004 receipt → memoryRoot pin → AxiomReveal). The settled-on environment has several non-obvious requirements; each one below has burned time at least once.

### Required env (live mode)
- `MINT_AGENT_PRIVATE_KEY` — owns all 3 demo iNFTs + AgentRegistry tokens, signs Storage / AxiomCommit / capabilities reads / memoryRoot / reveal
- `BASE_SEPOLIA_PRIVATE_KEY` — signs FeeSplitter on Base Sepolia (settlement leg)
- `ZG_ROUTER_KEY` — `sk-…` from `pc.testnet.0g.ai`. Auth ONLY; balance is on the dashboard, NOT the on-chain ledger (see below).
- **`ZG_FEEDBACK_PRIVATE_KEY`** — separate funded EOA for `giveFeedback`. Without this, the receipt step reverts `SelfFeedbackForbidden (selector 0xd857598e)` because the deployer EOA owns BOTH the audit and subject iNFTs. Generate via `viem/accounts.generatePrivateKey()`, fund with ~0.005 OG on Galileo (~100 calls of headroom).
- Base Sepolia + 0G RPCs (defaults work)

### 0G Compute Router 402 ≠ ledger underfunding
If `inferZG` returns HTTP 402 `{"code":"insufficient_balance"}`, the fix is **NOT** `bun run scripts/fund-zg-router.ts`. That script funds the broker-direct ledger (Phase C-A), which is a parallel system the hosted Router does NOT see.

The hosted Router (Phase C-B, `router-api-testnet.integratenetwork.work`) has its own internal billing. Top up by:
1. Connecting `MINT_AGENT_PRIVATE_KEY`'s wallet on `pc.testnet.0g.ai`
2. Going to the **Billing** tab
3. Depositing 0G via the web UI

Verified 2026-05-03. The script's name is misleading — it's only useful if we ever pivot to broker-direct (Phase C-A), see `docs/PHASE-C-PARTNER-BLOCKER.md`.

### iNFT (ERC-7857) ≠ AgentRegistry agent (ERC-8004)
Two separate ERC-721 contracts, two separate token-ID spaces. The mint-agent script mints both in lockstep so currently `inftTokenId == registryAgentId == 1/2/3` for audit/oracle/swap, but this alignment is **not guaranteed long-term**. Always use `apps/tui/src/agent-registry.ts` `resolveAgent(name)` to get both IDs, never hardcode.

When calling `AgentRegistry.giveFeedback(agentId, …)`, pass the **registryAgentId**. When calling `AxiomCommit.commitPlan(tokenId, …)` or `AgentNFT.capabilities(tokenId)`, pass the **inftTokenId**. The orchestrator threads both through `AuditTarget.{agentId,registryAgentId}`.

### FeeSplitter EIP-8021 Schema 2 attribution
viem's `writeContract` silently strips trailing calldata bytes. Use `sendTransaction` directly when appending the EIP-8021 suffix — see `apps/demo/src/live-deps.ts` settle-leg for the pattern. CBOR encoding via `ox`. Schema 2 fixed in `a7ac844`.

### 0G RPC receipt-wait tolerance
0G testnet RPC is load-balanced; `waitForTransactionReceipt` polls a different node than the one that took the write, so receipts often appear "missing" for 30-60s after a successful tx. viem's defaults (`retryCount: 6`, exponential backoff) exhaust in ~12s and incorrectly throw `TransactionReceiptNotFoundError` on landed transactions. Use `retryCount: 150, retryDelay: 2_000` (linear) on any `waitForTransactionReceipt` call hitting 0G — see `apps/demo/src/loop-helpers.ts` for the pattern, plus a `getBlockNumber` fallback for the rare case the wait still throws.

### Known pre-existing test failures (don't debug, not your bug)
- `@zhgg/oracle-agent test` exits 1 — package has no test files yet
- `@zhgg/mcp-adapter test` has 1 failing test reading `apps/zhgg-mcp-adapter/src/routes/oracle.ts` via repo-root-relative path (works when run from repo root, fails when bun runs from package CWD)

Both predate any current branch's work.

## Frontend Optimization techniques:
when implementing any certain features, think about whether the following can be implemented:

# Bundle & cold load

- use custom version tailored to what i need, do lazy splits + modulepreload + inlined CSS
- middleware checks cookies for routing

# Prefetch

- login intent preloads routes + APIs before session resolves
- preload 7 critical APIs + preconnect WS
- hover prefetch for tickers, chat, agents, screener

# Caching

- SWR cache tiers (30s–1d) headers
- localStorage → React Query hydration (prices for example have 5min)
- Gemini context cache (30m KV)
- AI summaries + chart data cached/shared

# Streaming & parallelism

- real token streaming (no fake chunks)
- anti-buffering headers for ai chats
- parallel tool calls + batched prompts
- client side api batches over single endpoint

# Rendering

- lazy charts w/ reserved height (no layout shift)
- tab-level lazy loading
- memoized list items
- instant paint on cache hits
- extremely light weight DOM

# WebSocket

- single shared WS across app
- smart reconnect + visibility gating
- prefetch on connect

# Service Worker

- app shell precached
- NetworkFirst nav (3s timeout)
- fonts cached 30d, idle registration