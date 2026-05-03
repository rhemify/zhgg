# zhgg v2 — Canonical Product Spec

**Status**: Locked
**Deadline**: May 6, 2026 — ETHGlobal OpenAgents
**Branch**: siewwin
**Supersedes**: v1 (Stripe-for-AI-inference framing). v2 is the production spec.
**Authority**: This file overrides all previous specs and inline notes.

> Last verified: 2026-05-03 against branch `siewwin`. Slice X / Y / Z
> shipped (commits `bc0bc79`, `b4f0350`, `c1c5e66`); all 8 packages now
> live under `@zhgg/*` (`1f21343`); D1–D5 build order complete; phases
> 13–15 closed; phases 16–18 closed (real `DelegationManager`, prompt
> classifier optional, demo polish).

---

## What We Are Building

**zhgg is the substrate for agents that earn their own bills.**

Today, every "AI agent" is a human's wallet pretending to be an agent. The human funds it indefinitely, the human carries the keys, the human eats the loss when it goes wrong. There is no agent — there's a script with a budget.

zhgg breaks that loop. An agent is an iNFT (ERC-7857) with its own treasury, its own debit-style spend cap (ERC-7715), its own reputation (ERC-8004), and its own income stream (a KeeperHub workflow node people pay it to run). When the agent gets paid, the fee splits four ways via ERC-8021 — 85% to the agent's owner, 5% to KeeperHub, 5% to zhgg, 5% to a reputation commons.

The human funds *once* (mint cost) and the agent funds itself from there.

**Pitch in 10 seconds**: `audit.zhgg.eth` audits another agent's compliance with the EU AI Act, gets paid in USDC over x402, splits the fee on-chain, posts a verifiable receipt — all without a human in the loop.

---

## The Painpoint, Sharply

| Today | With zhgg |
|---|---|
| Human funds agent's API bill forever | Agent earns USDC running a workflow others pay for |
| Agent has unlimited spend if key leaks | ERC-7715 caps debit per epoch — leak = bounded loss |
| "Trust me bro" agent identity (hex address) | iNFT body + ENS face + ERC-8004 passport |
| Agent inference is opaque | 0G Compute TEE attestation on every call |
| Agent memory lives on someone's server | 0G Storage encrypted KV, root pinned to iNFT |
| Workflow creators get nothing when agents use their work | ERC-8021 routes 85% of every payment to the workflow's iNFT owner |

The wedge: **the EU AI Act takes effect August 2026**. Every agent making automated decisions inside the EU needs an auditable trail. `audit.zhgg.eth` is the seed product — a private, on-chain compliance auditor that other agents pay to certify them.

---

## Architecture: Body, Face, Brain, Income

```
                    ┌───────────────────────────┐
                    │    audit.zhgg.eth (ENS)   │  ← FACE (humans see this)
                    └──────────────┬────────────┘
                                   │
                     ┌─────────────▼──────────────┐
                     │   AgentNFT (ERC-7857)      │  ← BODY (treasury + manifest)
                     │   - tokenId = 1            │
                     │   - owner = 0xUser         │
                     │   - memoryRoot = bafy...   │
                     │   - spendCap (ERC-7715)    │
                     └──┬─────────┬─────────┬─────┘
                        │         │         │
                ┌───────▼──┐  ┌───▼────┐  ┌─▼──────────┐
                │ 0G       │  │ Keeper │  │ ERC-8004   │
                │ Compute  │  │ Hub    │  │ Reputation │  ← BRAIN + INCOME + PASSPORT
                │ (TEE)    │  │ Workfl.│  │ (cross-    │
                │ inference│  │ +x402  │  │ platform)  │
                └──────────┘  └────────┘  └────────────┘
                                   │
                          ┌────────▼─────────┐
                          │ ERC-8021 splits  │
                          │ 85/5/5/5 on every│
                          │ settlement       │
                          └──────────────────┘
```

| Layer | Standard / Tech | Role |
|---|---|---|
| **Face** | ENS subname (`*.zhgg.eth`) | Human-readable identity, set in ERC-8004 record |
| **Body** | ERC-7857 iNFT on 0G Galileo | Treasury, capability manifest, memory pointer |
| **Cap** | ERC-7715 (+ ERC-7710 delegation) | Debit-style spend cap per epoch — bounded blast radius |
| **Memory** | 0G Storage KV + Log | Encrypted past audits/decisions, root pinned to iNFT |
| **Brain** | 0G Compute TEE (qwen3.6-plus / GLM-5-FP8) | Verifiable inference, attestation root returned |
| **Income** | KeeperHub workflow node + x402 | Agent runs a "Verifiable AI Inference" node people pay for |
| **Passport** | ERC-8004 cross-platform reputation | Receipt of every job — portable across platforms |
| **Splits** | ERC-8021 calldata suffix | 85% owner / 5% KeeperHub / 5% zhgg / 5% commons |
| **Discovery** | KeeperHub MCP + ENS reverse | Other agents find `audit.zhgg.eth` via MCP, resolve to iNFT |
| **Pre-commit** | AXIOM-style `keccak256(plan)` | Plan hash committed before action, revealed post-execution |

---

## The Stripe Model (Critical — Don't Skip)

zhgg is **a primitive + two seed agents + an open onboarding CLI.** Not a one-shot agent. Not a closed marketplace.

```
PRIMITIVE          SEEDS                    OPEN ONBOARDING
─────────          ─────                    ───────────────
contracts/         apps/agents/             apps/mint-agent/
  AgentNFT          audit.zhgg.eth            CLI: mint a new
  SpendCap          oracle.zhgg.eth                iNFT-backed
  FeeSplitter                                      agent in
  AgentRegistry                                    < 5 minutes
```

**During the demo**, we mint a *third* agent live on stage from the audience — proves the platform isn't hardcoded to two agents we wrote.

```bash
$ bun mint-agent --name researcher --tier oracle --owner 0xJudge
✓ Minted iNFT #3 (tx: 0xab12...)
✓ Registered researcher.zhgg.eth (ENS subname)
✓ Posted to ERC-8004 registry (cross-platform passport)
✓ Listed in KeeperHub MCP server (other agents can discover)
✓ Deployed spend cap: 50 USDC / day
Done in 4m 12s. Your agent is live at researcher.zhgg.eth.
```

This is the "whoah" moment. Judges see open infrastructure, not a demo prop.

---

## Two Seed Agents

### `audit.zhgg.eth` — EU AI Act Compliance Auditor

**Painpoint**: EU AI Act (effective Aug 2026) requires automated-decision systems inside the EU to maintain an auditable provenance trail. No on-chain product does this today.

**What it does**: Given a target agent's iNFT address, it:
1. Reads the target's capability manifest (ERC-7857) and historical receipts (ERC-8004)
2. Runs probe prompts through the target, captures outputs
3. Queries `oracle.zhgg.eth` for current regulatory deltas (which laws changed this week)
4. Runs the audit verdict in 0G Compute TEE → returns attestation
5. Posts signed audit report to ERC-8004 (target now has a verifiable compliance receipt)
6. Charges 5 USDC via x402, splits 85/5/5/5 via ERC-8021

**Why TEE matters**: the audit verdict must be impossible for the auditor to forge after the fact. TEE attestation roots are pinned to the receipt.

**Why it earns**: every agent operating in the EU after Aug 2026 needs one of these. We seed the market.

### `oracle.zhgg.eth` — Regulatory + Price Data Oracle

**Painpoint**: agents need fresh signal but don't want to run their own scrapers, RPCs, or news pipelines.

**What it does**: exposes a `query(topic, params)` MCP tool. Internally:
1. Fetches/caches data (regulatory feeds, price feeds, model card registries)
2. Returns signed response with TEE attestation if requested
3. Charges 0.1 USDC per query via x402, splits 85/5/5/5

**Why it exists in v1**: `audit.zhgg.eth` calls it. Demonstrates *agent-to-agent commerce* — the audit agent pays the oracle agent on every audit. ERC-8021 splits fire on both legs.

---

## The Demo Loop (90 seconds, end-to-end)

```
[T+0s ]  User runs:  bun run demo "audit oracle.zhgg.eth"
[T+2s ]  audit.zhgg.eth  → reads oracle's iNFT manifest from 0G chain
[T+4s ]  audit.zhgg.eth  → queries oracle.zhgg.eth via KeeperHub MCP
                         → pays 0.1 USDC via x402 (ERC-7715 debit cap fires)
                         → ERC-8021 splits the 0.1 USDC: 0.085 owner / 0.005 each
[T+10s]  audit            → fetches current EU AI Act delta from oracle response
[T+15s]  audit            → encrypts probe prompts, runs in 0G Compute TEE
                         → TEE attestation root returned (0x9a...)
[T+25s]  audit            → keccak256(plan) committed (AXIOM pre-commit)
[T+27s]  audit            → writes audit report to 0G Storage Log
                         → memoryRoot updated on iNFT (tx: 0xbc...)
[T+35s]  audit            → posts ERC-8004 reputation receipt (cross-platform)
[T+40s]  audit            → returns: "oracle.zhgg.eth: COMPLIANT (attestation 0x9a...)"
[T+45s]  TUI shows: 2 transactions, 8 ERC-8021 split events, 1 attestation, 1 receipt

[T+60s]  Judge: "mint a new agent"
[T+62s]  bun mint-agent --name judgeagent --tier oracle --owner 0xJudge
[T+90s]  judgeagent.zhgg.eth live, listed in KeeperHub, has its own ERC-7715 cap
```

Every layer load-bearing. Cut anything and the loop breaks.

---

## Prize Track Alignment

| Track | Pool | What We Submit | Realistic Outcome |
|---|---|---|---|
| **0G Autonomous Agents, Swarms & iNFT** | up to 5 × $1,500 | iNFT body + 0G Storage encrypted memory + 0G Compute TEE inference + ERC-8021 royalty splits on usage. Two live agents, open mint CLI. | $1,500 |
| **KeeperHub** | $4,500 main + $500 feedback bounty | "Verifiable AI Inference" workflow node contribution (PR to KeeperHub). MCP exposure. ERC-8004 receipt + x402 payment on every run. FEEDBACK.md with honest integration report. | $1,500 main + $500 |
| **ENS** | $2,500 (one of two sub-tracks) | `*.zhgg.eth` subname registrar coupled with ERC-8004 passport. Reverse resolver maps iNFT → ENS. Every agent has a face. | $1,500–$2,500 |

**Focus pool**: $12k realistic, $17.5k ceiling.

**Dropped explicitly**: 0G Framework track, Gensyn AXL, Uniswap. Reasoning is in conversation history; do not relitigate.

---

## Tech Stack (Locked)

| Layer | Package | Version | Notes |
|---|---|---|---|
| Runtime | Bun | 1.2.x | Existing |
| Language | TypeScript | 5.x | Hard rule. No Python. |
| Schema | Zod | 4.x | Existing |
| Agent runtime | `openclaw` | `2026.4.25` | zhgg as registerProvider() plugin |
| iNFT standard | ERC-7857 | — | Deployed on 0G Galileo (16602) |
| Spend cap | ERC-7715 + ERC-7710 | — | Custom contracts (no audited library yet) |
| TEE inference | `@0glabs/0g-serving-broker` | `0.7.5` | Requires ethers v5 |
| 0G chain | `ethers` | `^5.8.0` | Required by 0G SDKs |
| 0G storage | `@0glabs/0g-ts-sdk` | `0.3.3` | KV + Log |
| x402 payment | `@x402/core`, `@x402/evm` | `2.10.0` | EIP-3009 settlement |
| MCP | `@modelcontextprotocol/sdk` | latest | KeeperHub MCP + our agents expose MCP |
| ENS | `viem` (built-in) | latest | NameWrapper for subnames |
| Cache | `lru-cache` | `^11` | Quote cache, identity cache |
| TUI | `@opentui/core` | `0.1.105` | Existing terminal dashboard |

**No Redis. No OPA/Rego. No Python. No Macaroons. No Anthropic reselling. No Uniswap, AXL.**

---

## Environment Variables

```bash
# 0G Chain (Galileo testnet)
ZG_RPC_URL=https://evmrpc-testnet.0g.ai
ZG_PRIVATE_KEY=0x...
ZG_CHAIN_ID=16602

# Base Sepolia (x402 USDC)
BASE_SEPOLIA_RPC_URL=https://...
BASE_SEPOLIA_PRIVATE_KEY=0x...

# KeeperHub
KEEPERHUB_MCP_ENDPOINT=https://app.keeperhub.com/mcp
KEEPERHUB_API_KEY=...                         # if their workflow contribution path requires it

# ENS (Sepolia for v1; mainnet stretch)
ENS_REGISTRY_ADDRESS=0x...                    # ENSRegistry on Sepolia
ENS_NAME_WRAPPER_ADDRESS=0x...
ZHGG_ENS_PARENT=zhgg.eth                      # parent name (we register subnames under)

# zhgg deployment
AGENT_NFT_ADDRESS=0x...                       # ERC-7857 deployment
SPEND_CAP_ADDRESS=0x...                       # ERC-7715 spend cap manager
FEE_SPLITTER_ADDRESS=0x...                    # ERC-8021 splitter
AGENT_REGISTRY_ADDRESS=0x...                  # ERC-8004 registry adapter

# zhgg internal
ZHGG_SCOPE_SECRET=...                         # HMAC for ExecutionScope (existing)
ZHGG_FEE_BPS=500                              # 5% to zhgg (of the 4-way split)
ZHGG_FEE_RECIPIENT=0x...                      # zhgg multisig
COMMONS_FEE_RECIPIENT=0x...                   # reputation commons multisig
KEEPERHUB_FEE_RECIPIENT=0x...                 # KeeperHub treasury (per their docs)
```

---

## Package Structure

```
zhgg/
├── contracts/
│   └── src/
│       ├── AgentNFT.sol                ERC-7857 iNFT (existing — extend with spendCap hook)
│       ├── SpendCap.sol                ERC-7715 spend cap manager (NEW)
│       ├── FeeSplitter.sol             ERC-8021 4-way split (NEW)
│       ├── AgentRegistry.sol           ERC-8004 registry adapter (NEW)
│       └── ENSRegistrar.sol            zhgg.eth subname registrar (NEW)
│
├── packages/
│   ├── router/                         @zhgg/router (existing — refactor, don't delete)
│   │   └── src/
│   │       ├── index.ts                public API
│   │       ├── intent.ts               InferenceIntent Zod schema
│   │       ├── scope.ts                HMAC ExecutionScope (existing)
│   │       ├── adapters/
│   │       │   ├── zg.ts               0G broker adapter (TEE inference)
│   │       │   └── x402.ts             x402 payment adapter
│   │       ├── audit.ts                0G Storage Log writer
│   │       ├── keeper.ts               KeeperHub MCP client
│   │       └── identity/
│   │           ├── inft.ts             ERC-7857 read/write
│   │           ├── erc8004.ts          ERC-8004 receipt poster
│   │           ├── erc7715.ts          spend cap check (NEW)
│   │           └── ens.ts              ENS resolve + reverse (NEW)
│   │
│   ├── sdk/                            @zhgg/sdk (existing intent classifier — keep)
│   ├── tools/                          @zhgg/tools (existing MCP tools — keep)
│   └── workflow/                       @zhgg/workflow (NEW)
│       └── src/
│           ├── verifiable-inference.ts KeeperHub workflow node we contribute
│           └── mcp-server.ts           exposes the workflow as MCP
│
├── apps/
│   ├── agents/                         (NEW)
│   │   ├── audit/                      audit.zhgg.eth
│   │   │   └── src/
│   │   │       ├── index.ts            entrypoint
│   │   │       ├── prompts.ts          probe prompts
│   │   │       ├── tee.ts              0G Compute TEE caller
│   │   │       └── report.ts           ERC-8004 receipt builder
│   │   └── oracle/                     oracle.zhgg.eth
│   │       └── src/
│   │           ├── index.ts
│   │           ├── feeds/              regulatory + price sources
│   │           └── mcp.ts              MCP tool exposure
│   │
│   ├── mint-agent/                     (NEW) open onboarding CLI
│   │   └── src/
│   │       └── index.ts                mints iNFT, ENS, registers, deploys cap
│   │
│   ├── demo/                           CLI demo runner (existing — refactor)
│   │   └── src/
│   │       └── index.ts                bun run demo "audit oracle.zhgg.eth"
│   │
│   └── tui/                            existing TUI dashboard — extend panels
│       └── src/
│           └── panels/
│               ├── agents.ts           NEW — list active iNFT agents
│               ├── splits.ts           NEW — live ERC-8021 splits
│               └── audit.ts            existing — 0G Storage log
│
└── docs/
    ├── SPEC.md                         this file
    ├── FEEDBACK.md                     KeeperHub integration report (deliverable)
    └── specs/                          EIP cheat sheets (existing per CLAUDE.md)
        ├── EIP-7857.md
        ├── EIP-7715.md
        ├── EIP-8004.md
        └── EIP-8021.md
```

---

## Code Style

```typescript
// Zod at every boundary
const AuditRequest = z.object({
  target: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  depth: z.enum(['fast', 'thorough']).default('fast'),
  payer_inft: z.bigint(),
});

// Result type — no thrown errors into business logic
type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

// Adapter interface (existing)
interface InferenceAdapter {
  infer(provider: Provider, prompt: string): Promise<InferenceResult>;
}

interface InferenceResult {
  response: string;
  cost_usd: number;
  latency_ms: number;
  attestation_root: string | null; // null if non-TEE
  receipt: string;                  // tx hash or x402 receipt
}

// AXIOM pre-commit
const planHash = keccak256(toUtf8Bytes(JSON.stringify(plan)));
await registry.commitPlan(tokenId, planHash);
const result = await execute(plan);
await registry.revealPlan(tokenId, plan, result);
```

**Rules**: no `any`. camelCase functions, PascalCase types, SCREAMING_SNAKE constants. No comments unless WHY is non-obvious. Zod parse at every external boundary.

---

## Testing Strategy

Framework: `bun test` + `forge test`

```
packages/router/test/        existing (290 tests passing — keep all)
contracts/test/              existing (45 tests passing — extend)
  ├── AgentNFT.t.sol
  ├── SpendCap.t.sol           NEW
  ├── FeeSplitter.t.sol        NEW
  └── AgentRegistry.t.sol      NEW
packages/workflow/test/      NEW
  └── verifiable-inference.test.ts
apps/mint-agent/test/        NEW
  └── mint.test.ts             integration: mints on local anvil
```

**Adapters (0G broker, x402, KeeperHub MCP, ENS) are NOT unit tested**. Tested via live demo against testnets. This is deliberate — mocked adapters lie.

---

## Always-Active Infrastructure (every agent call)

**As of 2026-05-01 — all 10 steps shipped.** Phase 13 closed steps
1/3/9/10, Phase 13b made step 6 a real ERC-8021 calldata-suffix
emission, Phase 13c shipped step 8 (storage log), and Phase 14d
extended step 2 with per-workflow `permissionId` scoping per ERC-7715.

```
                                           STATUS    NOTES
1. iNFT.capabilities() read              ✅ live     readAgentCapabilities (loop-helpers.ts)
                                                    fail-open when AGENT_NFT_ADDRESS unset.
2. ERC-7715 spend cap check              ✅ live     checkSpendCap with per-(account,asset,
                                                    permissionId) buckets. Default permissionId
                                                    derived from oracle topic via keccak.
3. AXIOM commit (keccak(plan) on-chain)  ✅ live     commitPlan in AxiomCommit.sol. Idempotent
                                                    same-block. 8KB plan-size cap.
4. 0G Compute TEE inference              ✅ live     inferZG (real with --live, mock-by-default).
                                                    TEE attestation verifier in RELAXED mode.
5. KeeperHub MCP settlement              ✅ live     payViaKeeperHubMarketplace via
                                                    @keeperhub/wallet@0.1.8. Real x402 round-trip
                                                    when KH_MARKETPLACE_SLUG set; falls back to
                                                    direct FeeSplitter.splitERC20 otherwise.
6. ERC-8021 split                        ✅ live     splitERC20Erc8021 reads msg.data trailing
                                                    16-byte magic, decodes Schema 0 codes, emits
                                                    ERC8021Attribution AFTER successful split
                                                    (no spam on revert).
7. ERC-8004 receipt post                 ✅ live     postReceipt with int128 boundary check.
8. 0G Storage Log write                  ✅ live     writeAuditLog in storage-log.ts (viem-pure)
                                                    + storage-log-zg.ts SDK adapter (ethers v6 +
                                                    @0gfoundation/0g-ts-sdk, dynamic-imported).
                                                    Gated on ZG_STORAGE_ENABLED=1.
9. iNFT.updateMemoryRoot()               ✅ live     pinMemoryRoot in loop-helpers.ts. Consumes
                                                    rootHash from step 8.
10. AXIOM reveal                         ✅ live     revealPlan with plan/result size caps.
                                                    Only fires when audit posted a real receipt.
```

All 10 steps fail-open when their address env var is unset, so partial-
live demos run without orchestrator branching. The `cross-agent.ts`
orchestrator emits a `TranscriptStep` event for every step name (see
`apps/demo/src/cross-agent.ts:18-32`), consumed live by the TUI's
events-runner (`apps/tui/src/events-runner.ts`).

Mock mode (`bun run apps/demo audit ...` without `--live`) returns
deterministic synthetic responses with `attestation_root: null` and
mock txHash sentinels prefixed `0x6d6f636b…` (ASCII "mock") so the
transcript can never be confused with a real on-chain run.

`--live` mode performs the real-settlement testnet path:
- Real `inferZG` calls to `router-api.0g.ai/v1`
- Real settlement: KeeperHub marketplace OR direct
  `FeeSplitter.splitERC20` (configurable per env)
- Real `AgentRegistry.giveFeedback` post on 0G Galileo
- Real 0G Storage Log write + memoryRoot pin (when `ZG_STORAGE_ENABLED=1`)
- Real AXIOM commit/reveal (when `AXIOM_COMMIT_ADDRESS` set)

---

## Success Criteria (Specific, Testable)

**Contracts:**
- [ ] AgentNFT (ERC-7857) deployed on 0G Galileo, tokenId logged
- [ ] SpendCap (ERC-7715) deployed, debit fails closed when cap exceeded
- [ ] FeeSplitter (ERC-8021) deployed, splits 100 USDC → 85/5/5/5 in single tx
- [ ] AgentRegistry (ERC-8004 adapter) deployed, posts receipt cross-platform
- [ ] ENSRegistrar deployed on Sepolia, mints `*.zhgg.eth` subnames

**Two seed agents:**
- [ ] `audit.zhgg.eth` minted, ENS resolves to iNFT, ERC-8004 receipt posted
- [ ] `oracle.zhgg.eth` minted, exposes MCP `query()` tool, charges 0.1 USDC
- [ ] `audit` calls `oracle` via KeeperHub MCP, x402 settles, ERC-8021 splits visible on-chain
- [ ] `audit` runs probe in 0G Compute TEE, attestation root returned
- [ ] `audit` writes audit report to 0G Storage Log, memoryRoot updated

**Open onboarding:**
- [ ] `bun mint-agent --name X --tier oracle --owner 0x...` mints iNFT + ENS + registers + caps in <5 min
- [ ] Newly minted agent listed in KeeperHub MCP server, discoverable by other agents

**KeeperHub workflow contribution:**
- [ ] `verifiable-inference` workflow node merged or PR open against KeeperHub
- [ ] FEEDBACK.md filled with honest integration notes (deliverable for $500 bounty)

**Demo:**
- [ ] `bun run demo "audit oracle.zhgg.eth"` runs end-to-end in <60s
- [ ] TUI shows: 2 active agents, 2 transactions, 8 split events, 1 TEE attestation, 1 receipt
- [ ] Live mint of third agent during demo runs in <5 min

**Quality (current state, 2026-05-01):**
- [x] `bun test` — 485+ tests pass across 35 files
- [x] `forge test` — 134 tests pass across 8 suites
- [x] `bun run check-types` exits 0 across all 9 packages
- [x] All 10 always-active loop steps live (Phase 13)
- [x] ERC-7715 per-workflow `permissionId` scoping (Phase 14d)
- [x] Real ERC-8021 calldata-suffix emission on settlement (Phase 13b)
- [x] Smart wallet receiver for KH 70% leg auto-split (Phase 13d)
- [x] ENS layer optional (Phase 15a — gated on `ENS_REGISTRAR_ADDRESS`)
- [ ] Total demo cost ≤ $0.50 USDC across all testnet calls

---

## Boundaries

**Always:**
- Validate all external input with Zod
- Return `Result<T>` from adapters — never throw into business logic
- Verify TEE attestation in-process before returning 0G Compute responses
- KeeperHub MCP on every payment path (no direct viem settlement in production path)
- ERC-7715 spend cap check before any debit
- AXIOM pre-commit hash before any state-changing action
- 0G Storage log entry for every inference call (async, non-blocking)
- Commit only to `siewwin` branch
- Update `EIP-XXXX.md` cheat sheet under `docs/specs/` whenever an EIP becomes load-bearing

**Ask first:**
- Any new npm dependency
- Schema shape change on `InferenceIntent` or `AgentManifest` (downstream breakage)
- Mainnet deployment (testnet only for v1)
- Contributing the KeeperHub workflow node as a public PR (their feedback flow)

**Never:**
- Store raw prompts (only keccak256 hashes in audit log)
- Block agent response on 0G Storage write (always async)
- Use Python
- Implement Redis, OPA, Rego, Macaroons in v1
- Reskin StakeHumanSignal or AgentCircle (user's prior work — pivot to "agents earning own bills" thesis)
- Resell Anthropic/OpenAI inference (ToS violation)
- Touch `apps/web` (marketing site is done)
- Commit `.env`, `.claude/`, `CLAUDE.local.md`, or any `.md` file (per local rules) unless explicitly asked

---

## What v2 Cuts From v1

| Cut | Reason |
|---|---|
| 4-mode router (`fast`/`verified`/`consensus`/`pipeline`) | Mode-explosion hides the product. v2: one path — TEE inference always, with optional skip. |
| Provider pool with x402 Bazaar adapter | Provider routing is not the wedge. The wedge is agents earning their own bills. x402 stays only as KeeperHub payment rail. |
| "Stripe for AI inference" framing | Generic. "Agents earning own bills" is the painpoint that gets a "whoah". |
| `apps/paywall/` | Anthropic reselling. ToS violation. Already cut in v1, stays cut. |
| Direct Anthropic rail | Same reason. Stays cut. |
| Macaroons | Deferred to v2 (pre-pivot). Now permanently out of scope for hackathon. |
| ERC-8004 as soft gate | v1 said "warn and proceed". v2 makes it first-class — required for receipt posting. |
| ERC-8021 calldata stub | v1 stubbed it. v2 implements actual 4-way splitter contract. |
| 0G Framework track | Different submission shape. Our project is agent-first, not framework-first. |
| Gensyn AXL track | Transport layer — we don't have a real reason for agents to hide on private mesh. |
| Uniswap track | Existing swap tools in `packages/tools` stay as utilities, no Uniswap submission. |

---

## What v2 Adds Over v1

| Added | Reason |
|---|---|
| ERC-7715 spend caps | Debit-style bounded spend. Key leak = bounded loss. Differentiator vs every "agent wallet" today. |
| ERC-8021 4-way splitter contract | Real contract, not stub. 85% to agent owner = workflow creators get rewarded. |
| Two seed agents (`audit` + `oracle`) | Concrete economic loop. Audit pays oracle. ERC-8021 fires twice per audit. |
| `mint-agent` CLI | Open onboarding. Demo's "whoah" moment. Proves platform isn't hardcoded to two agents. |
| KeeperHub workflow node contribution | Luka's explicit ask: contribution-grade, not black-box usage. Unlocks $500 feedback bounty. |
| ENSRegistrar contract | Agent face. First 10 seconds of demo readable. Couples ENS + ERC-8004 narrative. |
| AXIOM pre-commit pattern | Plan hash on-chain before action. Tampering bound by hash mismatch. Cheap (one storage write). |

---

## Build Order (5 days, ~1,400 LOC)

| Day | Tasks | LOC |
|---|---|---|
| **D1** | SpendCap.sol + FeeSplitter.sol + AgentRegistry.sol + ENSRegistrar.sol + forge tests | ~400 |
| **D2** | KeeperHub workflow node (`packages/workflow/`) + MCP server exposure + extend AgentNFT.sol with spendCap hook | ~350 |
| **D3** | `audit.zhgg.eth` agent (probe runner, TEE caller, ERC-8004 receipt builder) | ~300 |
| **D4** | `oracle.zhgg.eth` agent + `mint-agent` CLI + ENS subname flow | ~250 |
| **D5** | TUI extensions (agents/splits panels) + integration test + demo recording | ~100 |

Cushion: 50–100 LOC for surprises. If we hit Day 4 over budget, cut TUI extensions and use raw logs.

---

## Open Questions (Surface Now)

1. **KeeperHub workflow contribution path**: do we PR directly to their repo, or submit via their hosted workflow editor? Need to read `docs.keeperhub.com/cli` — possibly clarify with Luka in their Discord.
2. **ENS parent name**: do we own `zhgg.eth` already, or do we need to acquire it on Sepolia testnet? If acquiring on mainnet, that's $5–$50/yr; on testnet it's free but doesn't carry to demo if judges check mainnet.
3. **0G Galileo + Base Sepolia interop**: x402 USDC settles on Base Sepolia, iNFT lives on 0G Galileo. We need a bridge or settle in 0G-native USDC. Need to confirm 0G has a USDC equivalent on testnet, otherwise the cross-chain dance becomes a v1 risk.
4. **ERC-7715 reference implementation**: no audited library exists. We write our own contract — is the user OK with unaudited custom code in the demo path, or want a simpler `mapping(address => uint256)` cap manager that we don't claim is ERC-7715-compliant?
5. **`audit.zhgg.eth` probe prompts**: who writes the EU AI Act probe set? This is the substance — bad probes = unconvincing auditor. Need 2–3 hours with the actual EU AI Act text.

These five must be resolved before D1 starts.

---

## Recon Status

| Item | Status | Finding |
|---|---|---|
| openclaw package | ✓ | `openclaw@2026.4.25` |
| 0G broker SDK | ✓ | `@0glabs/0g-serving-broker@0.7.5` (ethers v5) |
| 0G Storage SDK | ✓ | `@0glabs/0g-ts-sdk@0.3.3` |
| x402 packages | ✓ | `@x402/core@2.10.0` + `@x402/evm@2.10.0` |
| KeeperHub MCP | ✓ | `https://app.keeperhub.com/mcp` |
| 0G Galileo RPC | ✓ | `https://evmrpc-testnet.0g.ai` ChainID 16602 |
| ERC-8004 deployment on 0G | ✅ | `AgentRegistry.sol` shipped + tested |
| ERC-7715 reference | ✅ | `SpendCap.sol` with per-`permissionId` scoping shipped |
| ENS on testnet | ✅ | `ENSRegistrar.sol` shipped — and now optional (Phase 15a) |
| 0G Galileo ↔ Base Sepolia bridge | ⚠ | Not bridged. Receiver wallet factory needs a Base-resident `ownerOf` source — documented as Bucket B decision in Phase 14 audit. |

---

## Phase 13–15 Progress (post-spec, post-D5 build)

The original 5-day build order shipped + the always-active loop closed.
What landed beyond the original SPEC, in commit order on `siewwin`:

### Phase 13 — Close always-active loop steps 1/3/9/10 + ERC-8021 + 0G SDK + smart wallet
- `caf0868` — `AxiomCommit.sol` (commit/reveal log) + `loop-helpers.ts` (capabilities read, axiom commit/reveal, memoryRoot pin) wired into `cross-agent.ts`
- `a3de585` — `lib/ERC8021Suffix.sol` library + `splitERC20Erc8021` on FeeSplitter (real calldata-suffix parsing) + TS encoder `apps/demo/src/erc8021-suffix.ts`
- `178d998` — `packages/workflow/src/storage-log-zg.ts` ethers v6 / `@0gfoundation/0g-ts-sdk` SDK adapter behind dynamic imports
- `cc5fd43` — `AgentReceiverWallet.sol` + factory (CREATE2 per-iNFT receiver, public `splitMyBalance`, ERC-1271 sigs)
- `b12fa66` — Critical fix: viem `encodePacked` for AXIOM commitId + SOL↔TS parity tests on both AXIOM and ERC-8021 fixtures
- `8a3e1b8` — Deploy scripts updated for AxiomCommit + AgentReceiverWalletFactory
- `4451e26` — Wired `writeStorageLog` into `live-deps.ts` so steps 8 → 9 chain end-to-end live

### Phase 14 — Hardening (5 phases, all DoS surfaces + test gaps closed)
- `9dfbc88` (14a) — Contract hardening: `splitMyBalance` dust no-op, `isValidSignature` burn-tolerance, `PlanRevealed`/`ResultTooLarge` 8KB cap
- `9120181` (14b) — TS robustness: strict viem `PublicClient`/`WalletClient` types, Go-tuple drift guard in storage-log-zg, single-pass ASCII validation
- `76d06c3` (14c) — Coverage gaps: CREATE2 SOL↔TS parity, splitMyBalance-after-burn, `loadSdk` failure path, sub-min-suffix ordering, `decodeSchema0` fuzz. **Surfaced + fixed real bug**: FeeSplitter now emits `ERC8021Attribution` only on successful split (no spam on revert)
- `fc30697` (14d) — ERC-7715 per-workflow `permissionId` scoping (`grantPermission`/`spendPermission`/`revokePermission`/`permissionOf`). Legacy `bytes32(0)` bucket preserved
- `195aad7` (14e) — TUI live event subscription via `events-runner.ts` projecting orchestrator `TranscriptStep` events to TUI state, with integration test against real `runCrossAgentDemo` run

### Phase 15a — ENS-optional mint flow
- `4b225ab` — `mint-agent` flow gated on `ENS_REGISTRAR_ADDRESS`. When absent: skip subname mint + text records, omit `ens` metadata key on ERC-8004 register, success banner prints `iNFT #N is live` with canonical `eip155:16602:<contract>:<tokenId>` id. Lets hackathon teams ship without owning a parent ENS name.

### EIP R&D outcomes (no code, persisted in `docs/specs/` + `docs/research/`)
- **EIP-7521** (General Intents) — **rejected**. Stranded Draft, zero production usage. Every primitive 7521 defines we already have a stronger version of (`AxiomCommit`, `SpendCap` per-permissionId, `AgentReceiverWallet` ERC-1271, x402 + FeeSplitter). Cross-chain follow-up: track ERC-7683 instead.
- **EIP-3009** (Transfer With Authorization) — **keep transitive**. Already used through `@keeperhub/wallet`. Direct integration would lock us to USDC-family stablecoins for zero new capability. Keep `packages/workflow/src/x402.ts` as a server-side gate (we accept 3009-signed payments via the x402 facilitator); never construct authorizations ourselves.
- **EIP-8183** (Agentic Commerce Protocol) — **NO for hackathon, LATER as bolt-on**. Real Draft (Feb 2026, ETH Foundation + Virtuals Protocol authors). Solves "agent hires agent" arbitration with neutral evaluator role — a problem zhgg doesn't have yet. Map to existing primitives: `AxiomCommit + SpendCap + AgentReceiverWallet + FeeSplitter + AgentRegistry`.
- **EIP-4337** (Account Abstraction + Paymaster) — **demo stub only**. Real impl is 400-600 LOC + EIP-7702 or SimpleAccount refactor. Stub `paymasterPayUSDC()` returning `0xPM…` receipt for TUI badge. Post-hackathon: Coinbase CDP paymaster ($15k Base Gasless Campaign credits).
- **EIP-4626** (Tokenized Vaults) — **post-hackathon**. No canonical-USDC 4626 vault on Base Sepolia (Aave testnet uses mock USDC, not Circle USDC). Parking funds breaks "key leak = bounded loss" invariant. Zero demo value on testnet.
- **Across Protocol** (cross-chain intents) — **YES, small slice**. Base Sepolia SpokePool `0x82B5…0F8F` deployed. 1-3s finality. Aligns with ERC-7683 trajectory. Verify testnet relayer liveness with $0.001 test deposit before promising on stage.
- **Multi-leg PaymentIntent** — implemented in `packages/workflow/src/multi-leg-relay.ts`. EIP-712 signed envelope (`from`, `nonce`, `deadline`, `legs[]`) + per-chain fan-out relayer with replay-defense store. Production rail for the agent-pay-agent loop spanning Base + 0G.
- **Prompt-aware classifier** — **YES, ship this week**. ~200 LOC TS. Anthropic Haiku 4.5 + prompt caching = ~$0.00025/call, ~1s latency. Slots into existing `Mode` enum + `policy.checkSpendCap`. Fail-open default keeps mocked tests green.

---

## Phase 16 — ERC-7710 Delegations (planned, ~150 LOC + tests)

### Why

The EIP-7521/3009 R&D converged on the same gap: **for the 12 of 18
intents in `CLAUDE.md` that authorize arbitrary contract calls** (e.g.
`limit_swap`, `stop_loss`, `rebalance`, `add_liquidity`,
`recurring_swap`), neither x402 (single-shot HTTP payment) nor SpendCap
(rolling budget on a single asset) is sufficient. We need
`{rail: 'erc7710', delegationContext: bytes}` so an agent can act on a
user's behalf within signed caveats.

ERC-7715 (which we have via `SpendCap.sol`) covers the *grant* side.
ERC-7710 is the *redemption* side — the missing on-chain primitive.

### Scope

**Contract — `contracts/src/DelegationManager.sol`** (~150 LOC):
Implements the single ERC-7710 interface verbatim (see
`docs/specs/EIP-7710.md`):
```solidity
function redeemDelegations(
    bytes[] calldata _permissionContexts,
    bytes32[] calldata _modes,
    bytes[] calldata _executionCallData
) external;
```
Caveat enforcement starts minimal: allowed-target list +
`SpendCap.spendPermission` integration so each redemption debits the
caller's budget by `(asset, amount)` in the matching `permissionId`
bucket. Atomic batch — one revert reverts all.

**Tests — `contracts/test/DelegationManager.t.sol`** (~12 cases):
- happy path: redeem with valid context → atomic batch executes
- caveat fail: target outside allowlist → revert
- cap fail: SpendCap drained → revert
- expiry: timestamp past `validBefore` → revert
- ERC-1271 sig delegation (smart-wallet authorizer) → succeeds
- replay: same context twice → second reverts
- pre-flight simulate (per spec security note)

**TS helpers — `packages/workflow/src/delegation.ts`** (~80 LOC):
- `buildDelegation()` — EIP-712 typed-data builder
- `signDelegation()` — viem `signTypedData` for EOA grantors
- `encodePermissionContext()` — ABI encoder for the `bytes` payload

**Intent palace integration — `packages/sdk/intents/_types.ts`**:
add the rail enum suggested by the EIP-3009 R&D —
`rail: 'x402' | 'spendcap' | 'erc7710' | 'direct'`. Action-class intents
(swap, rebalance, etc.) declare `rail: 'erc7710'` and their executor
calls `delegationManager.redeemDelegations(...)`.

**Deploy script** — extend `Deploy0GContracts.s.sol` (or add a Base
Sepolia variant if the user wants delegation on Base for swap intents).

### Constraints

- TS / bun / viem (consistent with the rest of the stack)
- Foundry forge for tests (≥10 cases)
- ≤5 files touched per atomic commit, no `.md` commits
- No code in this section yet — scope only

### Out of scope (for Phase 16)

- ERC-7683 cross-chain intent format (separate phase if cross-chain
  becomes a real requirement)
- Self-hosted x402 facilitator
- Full MetaMask-style caveat framework — minimal allowed-target +
  cap-bound is enough for the 12 action intents

### Acceptance

- `forge test --match-path test/DelegationManager.t.sol` ≥10/10 green
- `bun test packages/workflow/test/delegation.test.ts` covers
  build/sign/encode round-trip
- Existing tests stay green (134 forge + 485 bun + types)
- `docs/specs/EIP-7710.md` updated with implementation status

---

## Phase 17 — Prompt-aware mode classifier (planned, ~200 LOC)

### Why

The `Mode` enum (`'fast' | 'verified' | 'consensus' | 'pipeline'`) exists in
`router.ts:649` but mode is currently **caller-supplied**. A trivial prompt
("1+1=?") gets the same `consensus` cost as a hard prompt ("write a smart
contract"); a hard prompt with `mode: 'fast'` gets a one-shot answer when it
should have escalated. Both are user-experience and cost-efficiency wins
worth a hackathon-scale fix.

### Scope (~200 LOC TS, 0 contracts)

- New `packages/router/src/classifier.ts` (~80 LOC) — Anthropic Haiku 4.5
  with cached system prompt. `classifyComplexity(prompt) → Result<{score,
  recommended, confidence}>`. `FetchLike`-injectable per `zg-router.ts`
  pattern.
- New `packages/router/src/mode-decider.ts` (~40 LOC) — pure function
  `decideMode(requested, classified, scope, policy)`. Rules: confidence < 0.7
  → never override; never-downgrade-CRITICAL; emit `route.mode_overridden`
  event on every change.
- 2-line touch in `router.ts:route()` between `policy_passed` and the mode
  switch — call classifier if `opts.classifier` provided (default undefined →
  skip, current behavior).
- 2-line wire in `live-deps.ts` to thread the dep, gated on
  `process.env.ZHGG_AUTO_MODE === '1'`.
- 3 new tests: `classifier.test.ts` (mocks Anthropic), `mode-decider.test.ts`
  (pure unit), `router.test.ts` adds "classifier upgraded fast → consensus,
  spend cap rejects, returns policy error" (proves fail-safe).

### Critical wiring detail

After classifier override, **must re-run** `evaluate(intent_with_new_mode,
scope, now())` so upgraded cost re-checks against `checkSpendCap`. Without
this the classifier could push spend past the cap. 2-line change in
`router.ts`.

### Cost economics

- Cached system prompt: $0.10 / 1M input tokens (10× cheaper than uncached)
- Per-call total: ~$0.00025 (≈ 2.5× cheaper than one 0G inference call)
- Latency: ~1s p50 added to a 5-15s loop — invisible

### Acceptance

- `bun test packages/router/test/classifier.test.ts` + `mode-decider.test.ts`
  + `router.test.ts` cases all green
- Existing 485+ bun tests stay green (fail-open default)
- `docs/research/prompt-aware-classifier.md` exists (already shipped)

---

## Phase 18 — Demo polish (Across cross-chain + Paymaster stub)

### Slice X / Y / Z (post-Phase-18, 2026-05-02 → 2026-05-03)

| Slice | Commit | Surface | Status |
|---|---|---|---|
| X — `kh hire` close-the-loop | `bc0bc79`, `f60af3d` | `apps/tui/src/kh-hire-validate.ts` + dispatcher: pre-flight slug + required-input validation, x402 round-trip, audit row | shipped |
| Y — Canonical AuditReport writer | `b4f0350`, `f60af3d`, `23be14c` | `packages/workflow/src/audit-report.ts` + `writeAuditReport` 0G Storage anchor + ERC-8004 `feedbackHash` self-reference | shipped |
| Z — `@zhgg/mcp-adapter` HTTP server | `c1c5e66` | `apps/zhgg-mcp-adapter/src/{index,server,routes/*}.ts` exposing audit/oracle/swap as KH-callable endpoints | shipped |
| KH discovery | `712e9d4`, `4b4b468` | `apps/keeperhub-agent/src/endpoints/discover.ts` (paginated, 27 entries) + `kh inspect` | shipped |
| Package rename | `1f21343` | All 8 bare names → `@zhgg/*`. Workspace `bun install` clean. | shipped |
| Dead-code purge + barrels | `117369e`, `55cf818`, `aae8536` | TUI monolith split into focused modules; `@zhgg/audit-agent` etc. expose barrels | shipped |

### 18a — Across cross-chain optional slice (~80 LOC TS, 0 contracts)

Lets judges see "audit agent's USDC was on Arbitrum, oracle gets paid on
Base, filled in <3s" without any user-side bridging UI.

**Pre-flight (do this first):** verify Base Sepolia SpokePool
`0x82B564983aE7274c86695917BBf8C99ECb6F0F8F` fill latency end-to-end with a
0.001 testnet USDC test deposit. **If relayer liveness is dead, run a tiny
self-relayer for the demo OR skip this phase.**

**Files:**
- New `packages/workflow/src/across.ts` (~60 LOC) — `bridgeViaAcross({
  from, to, inputToken, outputToken, inputAmount, outputAmount,
  recipient })` calls `depositV3(...)` on origin SpokePool, awaits
  `FilledV3Relay` event on destination.
- 1-step insert at `apps/demo/src/cross-agent.ts:212` — fires only when
  `opts.fundingChain !== opts.network`.
- 1-line wire in `live-deps.ts` for the `bridgeViaAcross` dep.
- Demo flag `--funding-chain=arbitrum-sepolia` in `apps/demo/src/index.ts`.

**See** `docs/research/across-protocol.md` for full spec, fees, trust model.

### 18b — Paymaster stub for TUI badge (~30 LOC TS, 0 contracts)

Real ERC-4337 + paymaster integration is post-hackathon (400-600 LOC). For
the demo: deterministic stub returning `0xPM…` receipt → TUI renders
"💸 USDC-pays-gas" badge → narrative wins, engineering doesn't burn the
deadline.

**Files:**
- 1-function add in `apps/demo/src/live-deps.ts` — `paymasterPayUSDC()`
  gated on `process.env.AA_MODE === 'paymaster'`.
- 1 new transcript step name in `cross-agent.ts` — `paymaster.sponsored`.
- 1-row addition in `apps/tui/src/events-runner.ts` — render
  `💸 USDC-pays-gas` badge.

**See** `docs/specs/EIP-4337.md` for the post-hackathon real-impl path
(EIP-7702 → Coinbase CDP paymaster + Base Gasless Campaign credits).

### Acceptance

- 18a: `bun test packages/workflow/test/across.test.ts` covers happy path +
  relayer-timeout fallback + mocked-mode no-op
- 18b: TUI integration test asserts the badge renders for the
  `paymaster.sponsored` event
- Existing 485+ bun tests stay green
