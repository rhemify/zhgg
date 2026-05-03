# Hackathon Submission — zhgg

## Description

zhgg is on-chain infrastructure for autonomous AI agents with spending limit caps and fully-onchain audibility, stored in 0G Storage. Agents are known to have a spending problem, and a workflow problem. 

Each agent is an iNFT: an ERC-721 token backed by a smart-contract receiver wallet (AgentReceiverWallet). The wallet parks idle balances into an ERC-4626 yield vault so capital is never sitting still. When an agent needs to act, they can audit another agent, hire a workflow, swap tokens, transfer funds. It does so through a full ERC stack: ERC-7710 for delegated spend-cap authorization so one agent can authorize another to spend on its behalf, and ERC-4337 UserOps routed through Pimlico's bundler for gasless account-abstraction execution.

The operator console is a terminal UI. Agents live in terminals — text streams, log tails, wallet addresses. A TUI is the natural habitat. The operator types natural-language intents: `audit 2 mica`, `kh hire ml-risk-scorer`, `park 10 USDC`, `aa send 0xABCD... 0.01`. The dispatcher translates each into signed transactions, UserOps, or REST calls in real time, and an audit trail panel streams every on-chain event as it lands.

The oracle agent runs TEE-backed inference on 0G Galileo, scoring agents against EU AI Act, MiCA, GDPR-AI, or price-oracle topics. Every score is committed on-chain via AxiomCommit (commitPlan → revealPlan) — a hash-locked audit trail that makes each agent's compliance history tamper-evident and publicly verifiable.

Agents can also reach outward: the KeeperHub integration lets an iNFT agent discover third-party ML workflows on the marketplace, inspect their inputSchema and price, and autonomously pay and invoke them via x402 micropayments — no human in the loop, no API key shared with the caller.

---

## How It's Made

**Runtime stack:** TypeScript throughout, running on Bun for sub-100ms cold starts and native ESM. The TUI uses raw ANSI escape codes and `process.stdout.write` — no ncurses, no blessed, no React. Each frame is built as a string diff and flushed atomically so there's never a partial-render flicker. A keypress handler translates operator input into typed `IntentCommand` unions that flow through a parser dispatcher to individual agent modules.

**Chain integrations:** All on-chain writes use viem. 0G Galileo (chainId 16602) hosts the AgentNFT registry, AxiomCommit plan hashing, and AgentReceiverWallet yield vaults (ERC-4626). Base Sepolia hosts the DelegationManager for ERC-7710 spend-cap delegations. Pimlico's ERC-4337 v0.7 bundler handles UserOp submission and sponsorship for the AA wallet slice.

**The hacky part — 0G receipt polling:** 0G Galileo's testnet nodes reject `eth_getTransactionReceipt` with an immediate error (not a null response) for any pending transaction. viem's `waitForTransactionReceipt` interprets that first-poll error as a hard failure and throws immediately, well before the configured timeout. The fix: fire-and-forget. We submit the transaction, snapshot the block number *before* submission (needed to deterministically derive the AxiomCommit `commitId` via `keccak256(tokenId ++ planHash ++ sender ++ blockNumber)`), return the derived ID to the caller immediately, and let `waitForTransactionReceipt` confirm in the background — errors silently swallowed as non-fatal. The on-chain record lands; the UX never blocks.

**The hacky part — allowance:** ERC-20 `approve(amount)` on a re-used demo wallet gets consumed after the first run, causing `ERC20: transfer amount exceeds allowance` on every subsequent orchestration. Fix: check current allowance before every split; only re-approve if it's already below the payment amount, and approve `maxUint256` so the approval survives indefinitely across runs.

**KeeperHub (partner tech):** The `kh discover` / `kh inspect` / `kh hire` intent chain lets the TUI browse KeeperHub's public MCP workflow marketplace (~85 entries), validate required inputSchema keys client-side, and pay-and-invoke via x402 in a single operator command. The bearer key lives only in the agent process; it's never surfaced in the TUI or commit history.

**Oracle + TEE (0G):** The oracle agent sends a compliance-check prompt to a TEE-backed inference endpoint on 0G, receives a structured score, records the result on-chain via `giveFeedback` (ERC-8004 pattern), and commits the plan hash via AxiomCommit — all within a single `audit` intent. Topics (`eu-ai-act`, `mica`, `gdpr-ai`, `price`) are parsed at the TUI intent layer and passed through the full dispatch chain typed.

**Testing:** 89 unit tests (`apps/tui/test/tui-functions.test.ts`) cover every parser arm, the ANSI renderer helpers, format functions, and dispatch routing — run with `bun test`. The suite uses no mocks for the parser layer; it drives real parser logic with crafted input strings and asserts typed `IntentCommand` output.

---

## Tech Stack

### Ethereum Developer Tools
- **viem** — all on-chain reads/writes, ABI encoding, UserOp construction
- **Pimlico bundler** — ERC-4337 v0.7 UserOp submission + USDC ERC-20 paymaster
- **ERC-4337** (Account Abstraction) — SimpleAccount + AgentSimpleAccountFactory
- **ERC-7710** (Delegation) — DelegationManager on Base Sepolia, SpendCap caveats
- **ERC-4626** (Yield vault) — AgentReceiverWallet idle-balance parking
- **ERC-8004** (giveFeedback) — on-chain oracle result anchoring
- **AxiomCommit** — commitPlan / revealPlan hash-locked audit trail

### Blockchain Networks
- **0G Galileo** (chainId 16602) — AgentNFT registry, AgenticCommerce, AxiomCommit, ERC-4626 vaults, oracle feedback
- **Base Sepolia** (chainId 84532) — DelegationManager (ERC-7710), AA factory + bundler

### Programming Languages
- **TypeScript** — entire codebase (runtime, agents, TUI, web frontend)

### Web Frameworks
- **React 19** — web frontend
- **TanStack Router + Start** — file-based routing + SSR
- **Vite 8** — frontend bundler

### Databases
- None — chain state is the source of truth; no off-chain DB

### Design Tools
- None

### Other Technologies / Libraries / Frameworks
- **Bun** — runtime, package manager, test runner (replaces Node + npm)
- **Turbo** — monorepo task orchestration (build, dev, check-types)
- **viem** — Ethereum client library (typed ABI, multicall, EIP-712 signing)
- **Three.js** — 3D animation layer in the web frontend
- **TanStack Query** — server-state caching in the web frontend
- **Tailwind CSS 4** — utility-first styling
- **KeeperHub SDK / API** — workflow marketplace discovery, x402 payment + invocation
- **@keeperhub/wallet** — Turnkey-custodied wallet for x402 payment signing
- **Zod** — runtime schema validation (env vars, intent parser)
- **raw ANSI escape codes** — TUI renderer (no ncurses / blessed)
- **0G TEE inference endpoint** — oracle compliance scoring (EU AI Act, MiCA, GDPR-AI, price)
- **MCP (Model Context Protocol)** — `zhgg-mcp-adapter` exposes audit + swap agents as MCP-callable tools so KeeperHub (and any MCP client) can hire zhgg agents

### AI Tools Used
- **Claude (Anthropic)** — used throughout development as a pair-programmer: designing the ERC integration architecture, writing the intent parser dispatcher, debugging the 0G receipt-polling failure, drafting the fire-and-forget tx pattern, writing the 89-test unit suite, and iterating on the ANSI TUI renderer. Claude Code (CLI) was the primary interface — it read, edited, and ran files directly in the repo rather than generating standalone snippets.
- **0G TEE inference** — the oracle agent at runtime sends compliance-check prompts to a TEE-backed AI inference endpoint on 0G network; the model scores agents against regulatory frameworks (EU AI Act, MiCA, GDPR-AI) and returns structured JSON that is committed on-chain.

---

## Prize Applications

### 0G — $15,000

**Why we're applicable:**
zhgg uses 0G across three distinct layers simultaneously: (1) TEE-backed AI inference via the 0G Compute Router for on-chain compliance scoring (EU AI Act, MiCA, GDPR-AI, price), (2) ERC-8004 `giveFeedback` anchoring of every oracle result to the AgentRegistry contract on 0G Galileo, and (3) AxiomCommit `commitPlan` / `revealPlan` for a tamper-evident, hash-locked audit trail of every agent action. Audit results and agent plans are permanently anchored to 0G — not just referenced off-chain.

**Key code lines:**
- TEE inference call + ERC-8004 giveFeedback: https://github.com/rhemify/zhgg/blob/siewwin/apps/demo/src/live-deps.ts#L154
- AxiomCommit commitPlan (fire-and-forget, blockNumber-based commitId): https://github.com/rhemify/zhgg/blob/siewwin/apps/demo/src/loop-helpers.ts
- 0G Galileo chain client setup (zgRpc, zgWallet, zgAccount): https://github.com/rhemify/zhgg/blob/siewwin/apps/demo/src/live-deps.ts#L137
- TUI audit dispatch wiring (ZG_RPC_URL, ZG_ROUTER_KEY guards): https://github.com/rhemify/zhgg/blob/siewwin/apps/tui/src/index.ts#L546

**Ease of use:** 5/10

**Feedback:**
The Compute Router (pc.0g.ai / pc.testnet.0g.ai) was the hardest part — the minimum top-up requirement (3 OG) and the sign-up flow aren't documented prominently; we discovered it by trial-and-error. The EVM RPC (`evmrpc-testnet.0g.ai`) is solid and viem-compatible with no special config. The biggest pain point: `eth_getTransactionReceipt` on Galileo returns an immediate error (not `null`) for pending transactions, which breaks viem's built-in `waitForTransactionReceipt` on the very first poll. The fix required a fire-and-forget pattern and pre-submission block number snapshotting for deterministic commitId derivation — this behaviour should be documented (or fixed). A note in the docs saying "receipt polling returns errors, not null, for pending txs" would save builders hours.

---

### KeeperHub — $5,000

**Why we're applicable:**
zhgg implements the full bidirectional KeeperHub loop. Outbound: the TUI's `kh discover` / `kh inspect` / `kh hire` intent chain lets an iNFT agent browse the KeeperHub public marketplace (~85 workflows), validate required `inputSchema` keys client-side, and autonomously pay-and-invoke any listed workflow via x402 — no human needed. Inbound: `zhgg-mcp-adapter` exposes the audit and swap agents as MCP-callable HTTP tools, making zhgg's own agents hireable by any KeeperHub workflow over the same x402 surface. The platform is a two-sided market participant, not just a consumer.

**Key code lines:**
- x402 pay-and-invoke (`payViaKeeperHubMarketplace`): https://github.com/rhemify/zhgg/blob/siewwin/apps/demo/src/keeperhub-marketplace.ts
- `kh-hire` dispatcher (inspect → validate → pay → call): https://github.com/rhemify/zhgg/blob/siewwin/apps/tui/src/index.ts#L1782
- `kh discover` endpoint (listedSlug, priceUsdcPerCall, inputSchema): https://github.com/rhemify/zhgg/blob/siewwin/apps/keeperhub-agent/src/endpoints/discover.ts
- MCP adapter (zhgg as a hireable KeeperHub workflow): https://github.com/rhemify/zhgg/blob/siewwin/apps/zhgg-mcp-adapter/src/server.ts

**Ease of use:** 7/10

**Feedback:**
The marketplace REST API (`/api/mcp/workflows`) is clean and well-shaped — `listedSlug`, `priceUsdcPerCall`, and `inputSchema` give everything needed to validate and pay in one step. The main friction: the analytics endpoints (`/analytics/runs`, `/analytics/spend-cap`) return 401/404 for `kh_` org bearer tokens, so we couldn't surface spend tracking in the TUI. It would also help to have a sandbox slug that's always callable on the test environment so builders can verify the x402 round-trip without needing a real listed workflow. Documentation on what makes a workflow `listedSlug`-callable vs. not (currently `null` for many entries) would reduce trial-and-error.
