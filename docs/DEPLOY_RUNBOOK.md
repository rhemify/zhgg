# zhgg testnet deploy runbook

> Last verified: 2026-05-03 against branch `siewwin`.

End-to-end deploy + smoke-test sequence. Phases 16-25 contracts +
services. **No mocks, no stubs — every step is real.**

| Slice | Commit | Effect on this runbook |
|---|---|---|
| X | `bc0bc79` | TUI `kh hire` closes the agentic-commerce loop. No new deploy step. |
| Y | `b4f0350`, `f60af3d`, `23be14c` | Canonical `AuditReport` writer. Smoke-test posts a real ERC-8004 receipt referencing the canonical hash. |
| Z | `c1c5e66` | New service: `apps/zhgg-mcp-adapter` (HTTP, port `MCP_PORT=8080`, bearer `MCP_AUTH_TOKEN`). See Step 8 below. |
| Renames | `1f21343` | All 8 packages now use `@zhgg/*` (was bare). No on-chain effect. |

## Prereqs (you provide)

| Item | Where to get it | Why |
|---|---|---|
| `MINT_AGENT_PRIVATE_KEY` | Generate locally — `bun -e "import {generatePrivateKey} from 'viem/accounts'; console.log(generatePrivateKey())"` | Deployer + agent owner key |
| **0G Galileo gas** | https://faucet.0g.ai (0.1 0G/wallet/day) | Deploy AgentNFT/Registry/AxiomCommit/AgenticCommerce |
| **Base Sepolia gas** | https://www.alchemy.com/faucets/base-sepolia or Coinbase Base faucet | Deploy SpendCap/FeeSplitter/OwnerMirror/ReceiverFactory/DelegationManager/AAFactory |
| **Base Sepolia USDC** | https://faucet.circle.com (Base Sepolia network) | Smoke-test settlements |
| **`PIMLICO_API_KEY`** *(optional)* | https://dashboard.pimlico.io | Required only for live ERC-4337 paymaster smoke test (Phase 18) |
| **`ANTHROPIC_API_KEY`** *(optional)* | https://console.anthropic.com | Phase 17 classifier — fail-open without |
| **0G Compute `sk-` key** *(optional)* | https://pc.testnet.0g.ai (testnet console) — also fund 3 OG min via `bun scripts/fund-zg-router.ts` | Phase 4 of always-active loop — fail-open without |
| **`MCP_AUTH_TOKEN`** *(required for Step 8)* | `bun -e 'console.log(crypto.randomBytes(32).toString("hex"))'` | Bearer token for `apps/zhgg-mcp-adapter` (Slice Z). Server refuses to boot if empty. |

The optional keys are exactly that — every code path that depends on
one of them is fail-open and the smoke test marks the dependent step
`SKIP` rather than failing.

## Step 1 — Deploy 0G Galileo contracts

```bash
cd contracts
export PRIVATE_KEY=$MINT_AGENT_PRIVATE_KEY
forge script script/Deploy0GContracts.s.sol:Deploy0GContracts \
  --rpc-url https://evmrpc-testnet.0g.ai \
  --broadcast --slow --legacy
```

Captures + prints (save these):
- `AGENT_NFT_ADDRESS`
- `AGENT_REGISTRY_ADDRESS`
- `AXIOM_COMMIT_ADDRESS`
- `ACP_ADDRESS`

## Step 2 — Deploy Base Sepolia contracts

```bash
export KH_TREASURY=$(cast wallet address --private-key $PRIVATE_KEY)
export ZHGG_TREASURY=$KH_TREASURY     # all on one wallet for testnet; rotate in production
export COMMONS_TREASURY=$KH_TREASURY
forge script script/DeployBaseContracts.s.sol:DeployBaseContracts \
  --rpc-url https://sepolia.base.org \
  --broadcast --slow
```

Captures:
- `SPEND_CAP_ADDRESS`
- `FEE_SPLITTER_ADDRESS`
- `OWNER_MIRROR_ADDRESS`
- `RECEIVER_FACTORY_ADDRESS`
- `DELEGATION_MANAGER_ADDRESS`
- `AA_FACTORY_ADDRESS`

## Step 3 — Mirror your iNFT ownership to Base

```bash
# Mint an iNFT (Step 4 below covers this via mint-agent)
# Then mirror:
cast send $OWNER_MIRROR_ADDRESS "setOwner(uint256,address)" \
  $TOKEN_ID $AGENT_OWNER_ADDRESS \
  --rpc-url https://sepolia.base.org \
  --private-key $PRIVATE_KEY
```

The receiver wallet on Base reads `OwnerMirror.ownerOf` — without this
write, `splitMyBalance()` reverts `TokenIdNotMirrored`.

## Step 4 — Provision your first agent

```bash
export AGENT_NFT_ADDRESS=...      # from Step 1
export AGENT_REGISTRY_ADDRESS=... # from Step 1
export SPEND_CAP_ADDRESS=...      # from Step 2
export RECEIVER_FACTORY_ADDRESS=...# from Step 2 (optional — skip with empty)
export ZG_RPC_URL=https://evmrpc-testnet.0g.ai
export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
# ENS optional — leave ENS_REGISTRAR_ADDRESS unset to skip Phase 15a path
bun mint-agent --name testagent --tier oracle --owner $AGENT_OWNER_ADDRESS
```

Records the printed iNFT id (typically `1` for the first agent) for use
in `SMOKE_TOKEN_ID`.

## Step 5 — Run live smoke test

```bash
export SMOKE_TOKEN_ID=1
export USDC_BASE_SEPOLIA_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
bun run apps/demo/src/smoke-test.ts
```

Prints a checklist:

```
✓ iNFT capabilities         tokenId=1 owner=0x... manifest=...
✓ SpendCap permissionOf     max=50000000 remaining=50000000
✓ AxiomCommit.commitPlan    commitId=0x... tx=0x...
✓ Pyth ETH/USD              price=$3500.00 (raw=350000000000, expo=-8) publishedAt=...
✓ OwnerMirror.ownerOf       tokenId=1 owner=0x...
✓ AxiomCommit.revealPlan    tx=0x...
```

Any `✗` row — investigate the printed error. Any `⊘` row — the
optional env var that gates that step is unset (intentional skip).

## Step 6 — Verify ZG Compute Router credit

The router endpoint is `https://router-api-testnet.integratenetwork.work/v1`
(see `packages/workflow/src/adapters/zg-router.ts:18`). Funding the
ledger requires **>= 3 OG** (per 0G broker docs and `docs/0g.md`); the
faucet caps at 0.1 OG/wallet/day so plan multiple drips.

```bash
bun run scripts/fund-zg-router.ts --balance        # check current balance
bun run scripts/fund-zg-router.ts 3                # deposit 3 OG (one-time)
```

Mint the `sk-` key at https://pc.testnet.0g.ai once your wallet appears
funded; paste into `.env` as `ZG_ROUTER_KEY=sk-…`. Without this key,
`inferZG` returns synthetic responses prefixed `0x6d6f636b` — the audit
loop runs but the regulator-side `teeAttestation` field is `null` (the
canonical AuditReport schema models this honestly).

## Step 7 — Run TEE verifier sidecar (Phase 23)

```bash
cd apps/tee-verifier
bun run start
# Listens on http://localhost:8787/verify
```

Then in `apps/demo` `--live` mode set:
```bash
export TEE_VERIFIER_URL=http://localhost:8787/verify
export TEE_STRICT=1
```

The workflow's `verifyTeeAttestation` will POST against the local
sidecar and get `verdict: "structural"` for valid TDX quotes.

## Step 8 — Start the MCP adapter (Slice Z, `c1c5e66`)

Exposes `audit` / `oracle` / `swap` agents as KeeperHub-callable HTTP endpoints.

```bash
export MCP_AUTH_TOKEN=$(bun -e 'console.log(crypto.randomBytes(32).toString("hex"))')
export MCP_PORT=8080
bun run apps/zhgg-mcp-adapter/src/index.ts
# [zhgg-mcp-adapter] listening on http://localhost:8080 (auth: bearer)
# [zhgg-mcp-adapter] available agents: oracle, audit, swap
```

Routes (all `/agents/*` require `Authorization: Bearer $MCP_AUTH_TOKEN`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Unauth — KH ping target |
| GET | `/agents` | List `AgentDescriptor`s |
| POST | `/agents/audit/call` | Run audit, returns canonical AuditReport (Slice Y) |
| POST | `/agents/oracle/call` | Oracle data query (no env required) |
| POST | `/agents/swap/call` | Real Uniswap V3 swap on Base Sepolia |

Boot rules (`apps/zhgg-mcp-adapter/src/index.ts:340-377`):
- `MCP_AUTH_TOKEN` empty → exit 1, no server.
- Each agent's deps build independently — missing env for one route returns 503 on call, not boot failure.
- Audit route requires `ZG_PRIVATE_KEY`, `ZG_RPC_URL`, `AGENT_REGISTRY_ADDRESS`, `ZG_ROUTER_KEY`.
- Swap route requires `BASE_SEPOLIA_PRIVATE_KEY`, `BASE_SEPOLIA_RPC_URL`.

## Step 9 — End-to-end agent loop

```bash
bun run apps/demo/src/cross-agent-cli.ts audit testagent.zhgg.eth --live
```

Watches the 10-step always-active loop fire on real chains:
1. capabilities read (0G)
2. spend-cap check (Base)
3. AXIOM commit (0G)
4. 0G Compute TEE inference
5. KH marketplace OR FeeSplitter settlement (Base)
6. ERC-8021 attribution emitted
7. ERC-8004 receipt posted (0G)
8. Storage Log write (0G, when `ZG_STORAGE_ENABLED=1`)
9. memoryRoot pin (0G)
10. AXIOM reveal (0G)

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `TokenIdNotMirrored` on splitMyBalance | OwnerMirror not populated | Run `setOwner` on Base (Step 3) |
| `NotAuthorizedToCommit` on AxiomCommit | iNFT lives on different chain than caller's signer | Use the iNFT-owner key — operator path needs `setOperator` first |
| Pimlico bundler 401 | Mainnet method without API key | Set `PIMLICO_API_KEY` for non-testnet methods |
| Pyth Hermes 5xx | Hermes upstream issue | Retry — Pyth Hermes is occasionally flaky |
| Across deposit no fill | Testnet relayer offline | Run a self-relayer OR document the leg as deferred |

## What's NOT testable on testnet

- **TEE STRICT verifier cert chain validation** — needs Intel-signed
  TDX quote + Intel attestation root cert. Structural verifier passes;
  cert chain phase 23-extras lands when 0G Compute hands us a real quote.
- **ERC-4626 mainnet yield** — Base Sepolia has no canonical-USDC 4626
  vault. The wrapper is exercised against `MockERC4626` in unit tests.
  Mainnet integration substitutes a real Yearn V3 / Aave aUSDC address.
- **Across cross-chain mainnet fees** — testnet relayers are
  best-effort. Mainnet runs are real but require funded mainnet wallets.

These limitations are documented per-phase, NOT hidden as "TODO" stubs.
