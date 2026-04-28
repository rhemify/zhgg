# zhgg

**Trust-level inference router for crypto-native AI agents.**

Built for [ETHGlobal OpenAgents](https://ethglobal.com/events/openagents) — submitting to 0G, KeeperHub, and ENS prize tracks.

---

## The problem

AI agents in 2026 have wallets and USDC, not credit cards and API keys. They need:

- **Cheap inference** for routine tasks (research, classification)
- **Verifiable inference** for on-chain decisions (votes, trades, credentials) — a smart contract has to be able to prove an AI actually approved the action
- **Crypto-native payment** — no API keys, no Stripe, no human-in-the-loop
- **Settlement reliability** — silent payment failures break the agent loop

Today an agent developer wires this themselves. It's ~400 lines of fragile glue: provider selection, x402 payment, retry, audit logging, attestation verification. It breaks at 3am.

## What zhgg is

The Stripe for AI agent inference. One API surface, four trust modes:

| Mode | Behaviour | When to use |
|---|---|---|
| `zhgg/fast` | Cheapest live provider on x402 Bazaar | Research, classification, anything where the AI's answer doesn't move money |
| `zhgg/verified` | TEE-attested 0G Compute | The agent is about to take an on-chain action and a smart contract needs to verify the AI authorised it |
| `zhgg/consensus` | 3 providers in parallel + 0G TEE anchor | Multi-sig for AI: high-stakes decisions where accuracy AND proof matter |
| `zhgg/pipeline` | Cheap research → TEE-attested decision | Multi-step reasoning where step 1 doesn't need attestation but step 2 does |

Underneath: KeeperHub settles every payment, 0G Storage logs every event with `keccak256` hashes, an ERC-7857 iNFT carries the agent's identity, ERC-8021 calldata suffix captures protocol fees.

```
┌─────────────────────────────────────────────────────┐
│  agent calls router.route({ prompt, mode, budget })  │
└─────────────────────┬───────────────────────────────┘
                      ▼
        ┌──────────── policy ────────────┐
        │ scope check, mode allowed,     │
        │ spend cap, expiry              │
        └────────────┬───────────────────┘
                     ▼
        ┌──── unified provider pool ─────┐
        │ 0G Compute  ·  Bazaar (x402)   │
        │ ranked by price, filtered by   │
        │ trust requirement              │
        └────────────┬───────────────────┘
                     ▼
        ┌────── adapter dispatch ────────┐
        │ zg.infer()  or  x402.infer()    │
        └────────────┬───────────────────┘
                     ▼
        ┌────── KeeperHub MCP ───────────┐
        │ settle, retry, gas, nonce      │
        └────────────┬───────────────────┘
                     ▼
        ┌──── 0G Storage audit ──────────┐
        │ append-only log, keccak256     │
        │ hashed prompt + response       │
        └────────────┬───────────────────┘
                     ▼
        ┌────── ERC-8021 suffix ─────────┐
        │ protocol fee on every settle   │
        └────────────────────────────────┘
```

Full architecture: [`docs/architecture.md`](./docs/architecture.md). Pivot brief: [`docs/pivot.md`](./docs/pivot.md).

---

## Run it

```bash
bun install                            # one-time

# CLI demo — 5 headlines through the router with mock providers
bun --filter demo demo

# Live TUI dashboard — same demo, judge-friendly side-by-side panels
bun --filter @zhgg/tui router

# Type check (6 packages)
bun run check-types

# Tests (319 router + 45 contract)
cd packages/router && bun test
cd contracts && forge test
```

The demo prints 5 headlines: 3 routed through `zhgg/fast`, 2 through `zhgg/consensus`. Headline 5 deliberately produces 67% provider agreement so the `low_confidence` flag fires — that's the consensus mode's killer feature on display.

```
[5] Smart contract upgrade proposal passes
     mode:        consensus  (on-chain protocol consequence)
     response:    bullish
     providers:   x402:groq, x402:together, zg:0xnode-a
     cost:        $0.000480
     attestation: 0xde2f45…454b
     agreement:   67%  ⚠ low confidence
     audit_cid:   0x000000…0005
```

---

## Deploy contracts (testnet)

```bash
cd contracts
forge install                          # one-time
forge build
forge script script/Deploy.s.sol \
  --rpc-url $ZG_RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast
```

Copy the printed `AGENT_NFT_ADDRESS`, `ACP_STUB_ADDRESS`, `ZG_INFT_TOKEN_ID` into `.env`. The deploy script also mints the demo iNFT (token #1) with a permissive capability manifest.

---

## Prize tracks targeted

| Sponsor | Track | What we ship |
|---|---|---|
| **0G** | Best Agent Framework & Tooling ($7,500) | zhgg packaged as an OpenClaw provider plugin. 0G Compute powers `zhgg/verified` and the consensus anchor. 0G Storage holds every audit log entry. |
| **0G** | Best Autonomous Agents + iNFT ($7,500) | ERC-7857 iNFT (`AgentNFT.sol`) on 0G Galileo. Agent owns identity + memory root. `authorizeUsage` pays royalty to owner. Demo agent earns from usage and pays its own inference. |
| **KeeperHub** | Best Integration ($4,500) + feedback bounty ($500) | Every settlement (both adapters) routes through KeeperHub MCP. See [`docs/FEEDBACK.md`](./docs/FEEDBACK.md). |
| **ENS** | Creative Use ($2,500, stretch) | ENS text records as agent capability manifests. `agent.zhgg.eth` resolves via `zhgg.inft`/`zhgg.modes`/`zhgg.maxCostUsd` text records to the iNFT identity. |

**Total target: ~$20,500.**

---

## What's in the repo

```
zhgg/
├── packages/
│   ├── router/              @zhgg/router — the entire core (319 tests)
│   │   └── src/
│   │       ├── intent.ts            mode + output_type + provider types
│   │       ├── scope.ts             HMAC-signed ExecutionScope
│   │       ├── policy.ts            spend / latency / mode / expiry rules
│   │       ├── pool.ts              unified provider pool
│   │       ├── consensus.ts         majority-vote / cosine / numeric / json
│   │       ├── router.ts            mode orchestration + RouterEventBus
│   │       ├── adapters/
│   │       │   ├── zg.ts            0G broker adapter (TEE)
│   │       │   └── x402.ts          Bazaar adapter (x402 USDC)
│   │       ├── keeper.ts            KeeperHub MCP client
│   │       ├── audit.ts             async 0G Storage writer
│   │       ├── erc8021.ts           protocol fee calldata suffix
│   │       ├── identity/
│   │       │   ├── inft.ts          ERC-7857 iNFT adapter
│   │       │   └── ens.ts           ENS text-record agent resolver
│   │       ├── providers/
│   │       │   └── openclaw.ts      OpenClaw provider plugin
│   │       └── testing/
│   │           └── mock-stack.ts    shared demo/TUI mock stack
│   └── …
├── apps/
│   ├── demo/                CLI: 5 headlines, mock providers, prints summary
│   └── tui/                 Live dashboard: agent / routing / audit / settle
└── contracts/               Foundry workspace (45 tests)
    └── src/
        ├── AgentNFT.sol             ERC-7857 iNFT + royalties
        ├── ACPJobStub.sol           job lifecycle escrow
        └── interfaces/IERC7857.sol
```

---

## Tech stack

- **Runtime**: Bun
- **Language**: TypeScript (strict, no `any`)
- **Schema**: Zod
- **EVM**: ethers v5 (required by 0G SDKs)
- **Solidity**: 0.8.24 + Foundry + OpenZeppelin v5
- **0G**: `@0glabs/0g-serving-broker@0.7.5` (TEE inference) + `@0glabs/0g-ts-sdk@0.3.3` (storage)
- **x402**: `@x402/core` + `@x402/evm` (EIP-3009 USDC payments on Base Sepolia)
- **MCP**: `@modelcontextprotocol/sdk` (KeeperHub HTTP transport)
- **TUI**: `@opentui/core` (peer dep), with raw-ANSI live dashboard implementation
- **OpenClaw**: `openclaw@2026.4.25` (consumer of our provider plugin)

No Python. No Redis. No OPA. No Macaroons. No paywall server.

---

## Status

- ✅ 319 router unit tests + 45 Solidity tests, all green
- ✅ `bun run check-types` clean across 6 packages
- ✅ Demo runs end-to-end with mock providers
- ✅ Smart contracts compile + deploy via forge script
- ⏳ Live testnet deploy + video record happen at submission time
