# zhgg

A web3 agent execution runtime for Ethereum — scoped permission enforcement, policy-guarded tool execution, and unified payment rail support (x402 + MPP) packaged as a TypeScript SDK with an operator TUI.

Built for [ETHGlobal OpenAgents](https://ethglobal.com/events/openagents).
## Simplified execution runtime it solves
```
Intent (What does the user want to do?)
         ↓
Rails (What payment protocol rails are needed to purchase a certain service?)
         ↓
Execute (Where should the execution occur at?)
```
## What it does

zhgg provides the execution infrastructure that agents are missing: a structured intent taxonomy for web3 retail actions, a policy engine that enforces permissions at the tool layer, and a payment abstraction that unifies crypto (x402) and web2 (MPP) rails — so agents can act on behalf of users safely and verifiably on Ethereum.

```
User intent (structured)
         ↓
ExecutionContext (scoped, passkey-bound, TTL-limited)
         ↓
Policy Engine — evaluates action against rules before execution
         ↓
MCP Tool Layer — Uniswap, Aave, Lido, ENS, ...
         ↓
Payment Abstraction — x402 | MPP | onchain gas
         ↓
Onchain execution on Ethereum
```

## Core primitives

**ExecutionContext** — every agent run gets a scoped execution context. Agents never touch credentials directly. Permissions only narrow as they pass down a chain (attenuation — a sub-agent can never gain more scope than its parent).

**Policy Engine** — OPA-style rule evaluation at the tool call layer, not just at spawn time. Actions are classified by risk tier (LOW / MEDIUM / HIGH / CRITICAL) with stepped-up auth requirements. Prompt injection cannot bypass it because the constraint is enforced at execution, not in the LLM's judgment.

**Intent Taxonomy** — a structured schema of ~45 Ethereum retail intent classes across four tiers. Each intent maps to extracted params, a protocol template, a risk tier, and which protocol rails (ACP / MCP / payment) to activate. This is the core of what makes agent routing deterministic.

**Payment Abstraction** — unified support for x402 (crypto micropayments for data feeds and agent services), MPP (web2 rails for retail billing), and onchain gas. The runtime selects the right rail per action transparently.

**Virtuals ACP / Gensyn AXL Support** — route intents to specialist agents via the Virtuals Agent Commerce Protocol or communicate peer-to-peer across Gensyn's AXL encrypted mesh. Agents are sourced from the ecosystem rather than built in-house.

**ENS Identity Layer** — agent principals are bound to ENS names, not raw addresses. Enables human-readable agent identity, metadata storage, and access gating via ENS records.

## Intent taxonomy

The taxonomy is the foundation. It makes agent routing deterministic — no hallucinated tool calls, no ambiguous execution paths. Each intent class is fully specced: param schema, protocol template, risk tier, and protocol rails.

### Tier 1 — Casual (high frequency, low complexity)

| Intent | Example | Protocol |
|--------|---------|---------|
| `simple_swap` | "swap 100 USDC to ETH" | Uniswap v3 |
| `swap_with_slippage` | "swap but max 0.5% slippage" | Uniswap v3 |
| `send_token` | "send 50 USDC to vitalik.eth" | ERC-20 transfer + ENS |
| `check_balance` | "what's my ETH balance" | read-only |
| `check_portfolio` | "show all my holdings" | read-only |

### Tier 2 — Active Trader (conditional, time-sensitive)

| Intent | Example | Protocol |
|--------|---------|---------|
| `limit_swap` | "swap ETH to USDC if ETH hits $4000" | Uniswap v4 hooks |
| `stop_loss` | "sell my ETH if it drops to $2800" | Uniswap + price feed |
| `take_profit` | "sell 50% of my ETH at $4500" | Uniswap |
| `recurring_swap` | "buy $100 of ETH every Monday" | Uniswap |
| `price_alert` | "tell me when ETH hits $3500" | Chainlink feed |
| `rebalance` | "keep 60% ETH 40% USDC" | Uniswap |

### Tier 3 — DeFi Power User (complex, multi-step)

| Intent | Example | Protocol |
|--------|---------|---------|
| `deposit_lending` | "deposit 500 USDC to Aave" | Aave v3 |
| `withdraw_lending` | "withdraw my USDC from Aave" | Aave v3 |
| `yield_route` | "find best APY for my USDC" | Aave / Compound / Morpho |
| `borrow` | "borrow 200 USDC against my ETH" | Aave v3 |
| `repay` | "repay my USDC loan" | Aave v3 |
| `add_collateral` | "add collateral to my position" | Aave v3 |
| `leverage` | "open 2x long on ETH" | Aave + Uniswap |
| `liquid_stake` | "liquid stake 5 ETH" | Lido |
| `add_liquidity` | "add to ETH/USDC pool on Uniswap" | Uniswap v3 |
| `remove_liquidity` | "remove my LP position" | Uniswap v3 |
| `buy_nft` | "buy floor NFT from collection X" | OpenSea / Blur |
| `claim_airdrop` | "claim my airdrop" | protocol-specific |

### Tier 4 — Compound (multi-step chains)

| Intent | Example | Agents involved |
|--------|---------|----------------|
| `harvest_and_reinvest` | "claim rewards and restake" | harvest-agent → yield-specialist → executor |
| `borrow_and_swap` | "borrow USDC and buy ETH" | risk-agent → executor |
| `unwind_position` | "remove LP, repay loan, withdraw" | risk-agent → executor (ordered) |
| `rebalance_full` | "sell yield, rebalance portfolio" | yield-specialist → executor |

### Risk tier enforcement

| Tier | Behaviour |
|------|-----------|
| LOW | auto-execute, no confirmation |
| MEDIUM | show user summary, 5s to cancel |
| HIGH | explicit user confirmation required |
| CRITICAL | passkey sign required + policy check |

### Classifier output schema

Every intent produces a structured output the execution layer consumes directly:

```json
{
  "intent": "simple_swap",
  "params": {
    "from_token": "USDC",
    "to_token": "ETH",
    "amount": 100,
    "amount_type": "exact_in",
    "slippage_bps": 50
  },
  "risk_tier": "LOW",
  "protocol_rail": {
    "acp": [],
    "axl": [],
    "mcp": ["uniswap_v3_swap"],
    "payment": {
      "data_cost": null,
      "service_cost": null
    }
  }
}
```

## Monorepo structure

```
zhgg/
├── packages/
│   ├── sdk/      # ExecutionContext, policy engine, tool wrapping, payment abstraction
│   ├── tui/      # Operator control plane (Ink)
│   └── tools/    # MCP tool implementations (Uniswap, Aave, Lido, ENS, ...)
└── apps/
    └── demo/     # End-to-end demo agent
```

## TUI

The terminal UI is the operator control plane. It gives developers and ops teams visibility and control without a full platform build:

- Live agent activity feed with permission scopes
- Approve / deny queue for HIGH and CRITICAL risk actions with passkey confirmation
- Audit trail filterable by agent, risk tier, or protocol
- Payment rail spend monitoring (x402 vs MPP vs onchain gas)
- Virtuals / AXL agent marketplace management
- Policy editor — add and simulate rules live

## Why this is defensible

- **Policy-at-tool-layer** — constraints live at call time, not spawn time. Prompt injection cannot bypass them because the enforcement is in the execution layer, not the LLM.
- **Attenuation guarantee** — sub-agents can only narrow scope, never expand it. Enforced by the SDK, not by the agent's judgment.
- **Signed audit trail** — every action is logged and signed, forensically useful not just operationally. Enterprise compliance story (SOC2, fintech).
- **Protocol templates** — correct Ethereum DeFi integrations (Uniswap v3/v4, Aave v3, Lido) take months to harden. Each template is a defensive asset.
- **Unified payment rails** — nobody has cleanly abstracted x402 + MPP + onchain gas into one SDK primitive for agent use cases.

## Tech stack

- **Language**: TypeScript
- **TUI**: Ink (React for terminals)
- **Policy engine**: OPA (Rego)
- **Token format**: Macaroons (native attenuation support)
- **Identity**: ENS (agent principals, metadata, access gating)
- **Chain**: Ethereum
- **Protocols**: Uniswap v3/v4 · Aave v3 · Compound · Morpho · Lido · Curve · Balancer · OpenSea · Blur
- **Agent protocols**: Virtuals ACP · Gensyn AXL · MCP · x402 · MPP

## Hackathon prize tracks

| Sponsor | Track | Relevance |
|---------|-------|-----------|
| Uniswap Foundation | Best Uniswap API Integration | Uniswap is the primary swap execution tool across Tier 1–4 intents |
| Gensyn | Best Application of AXL | AXL is the peer-to-peer messaging layer for multi-agent coordination across compound intents |
| ENS | Best ENS Integration for AI Agents | Agent principals are ENS-bound; ENS used for address resolution in send intents and access gating |
| KeeperHub | Best Integration with KeeperHub | KeeperHub as the execution trigger layer for conditional and recurring intents |
| 0G | Best Agent Framework & Tooling | zhgg SDK is the framework-level primitive — execution context, policy engine, tool wrapping |

## Getting started

```bash
pnpm install
pnpm --filter @zhgg/sdk dev
```

## Business model

- **Execution fee** — small percentage of every action routed through the runtime
- **Payment rail margin** — basis points on MPP flows and x402 micropayment aggregation
- **Protocol distribution** — protocols pay to be the preferred route for relevant intent classes
- **Virtuals / AXL agent rev share** — percentage of agent earnings as marketplace operator
- **Enterprise** — hosted runtime with SLA, full audit trail, compliance story (SOC2 / fintech)
