# zhgg Architecture

> Last verified: 2026-05-03 against branch `siewwin`.

Top-level system map for judges and future maintainers. Two scenarios drive
the design: **audit** (auditor agent rates a target agent under EU AI Act,
posts canonical evidence) and **hire** (operator pays a public KeeperHub
workflow over x402 from inside the TUI).

## High-level lanes

```
                  ┌────────────────────────────────────────────────────┐
                  │                                                    │
   Operator UX ───►  apps/tui  ─── intents ───►  dispatchers ────────► │
   (terminal)      (raw ANSI,         (acp,kh-*,axiom,delegate,park..)  │
                    @opentui/core)                                      │
                  └─────────────────────────────────────────────────┐  │
                                                                    ▼  ▼
   ┌──────────────────┐    ┌──────────────────┐   ┌───────────────────────────┐
   │ apps/zhgg-mcp-   │    │ apps/keeperhub-   │   │   packages/workflow       │
   │   adapter        │    │   agent           │   │  (audit-report, x402,     │
   │ (HTTP, Slice Z)  │    │ (KH HTTP client)  │   │   delegation, multi-leg,  │
   │ /agents/*        │    │ list/discover/    │   │   storage-log, across…)   │
   └────────┬─────────┘    │ inspect/trigger   │   └────────────────┬──────────┘
            │              └─────────┬─────────┘                    │
            ▼                        ▼                              ▼
   ┌──────────────────┐    ┌──────────────────┐            ┌────────────────┐
   │ apps/agents/*    │    │ KeeperHub mainnet│            │ 0G Compute     │
   │ audit, oracle    │    │ /api/mcp/wf...   │            │ Router (TEE)   │
   │ runAudit() etc.  │    │ +x402 settle     │            │ (testnet URL)  │
   └────────┬─────────┘    └─────────┬────────┘            └───────┬────────┘
            │                        │                             │
            ▼                        ▼                             ▼
       ┌─────────────────────────────────────────────────────────────────┐
       │            on-chain settlement / state                          │
       │                                                                 │
       │ 0G Galileo (16602):                                             │
       │   AgentNFT, AgentRegistry (ERC-8004), AxiomCommit,              │
       │   AgenticCommerce (ACP / EIP-8183)                              │
       │                                                                 │
       │ Base Sepolia (84532):                                           │
       │   SpendCap (ERC-7715), FeeSplitter (ERC-8021), OwnerMirror,     │
       │   AgentReceiverWalletFactory, DelegationManager (ERC-7710),     │
       │   AgentSimpleAccountFactory (ERC-4337)                          │
       │                                                                 │
       │ 0G Storage Log:                                                 │
       │   canonical AuditReport bytes anchored by rootHash              │
       └─────────────────────────────────────────────────────────────────┘
```

## Data flow — audit scenario

`bun run apps/zhgg-mcp-adapter/src/index.ts` is up; an outside MCP client
(or the TUI) hits `POST /agents/audit/call`.

```
1. Bearer auth                          server.ts:55-62
2. Body parse + Zod                     routes/audit.ts (input-schemas.ts)
3. runAudit(target, deps, opts)         apps/agents/audit (re-exported via @zhgg/audit-agent)
   ├─ probes via inferZG                packages/workflow/src/adapters/zg-router.ts
   │   - testnet URL forced
   │   - x-tee-attestation header → opts.attestationRoot
   ├─ evaluate verdict + findings       audit-agent/src/runAudit.ts
   └─ buildFeedbackAnchor callback      apps/zhgg-mcp-adapter/src/index.ts:189-267
       - hash probe inputs / outputs    keccak256
       - buildAuditReport(...)          packages/workflow/src/audit-report.ts:131
       - canonicalizeAuditReport(draft) audit-report.ts:230 (zero feedbackHash + drop feedbackTx)
       - draft.anchors.feedbackHash = h
4. postReceipt → giveFeedback           erc8004.ts (writes ERC-8004 NewFeedback)
5. response: { report, canonicalReport }
```

The **orchestrator path** (`apps/demo/src/cross-agent.ts` via TUI live mode)
adds the optional legs the MCP path skips:

- AxiomCommit `commitPlan` (step 3 of always-active loop)
- 0G Storage Log write via `writeAuditReport` (canonical bytes pinned)
- AxiomReveal `revealPlan` (step 10)
- ERC-8021 calldata-suffix split on settlement

A regulator verifying a report:

```
1. Read NewFeedback event → (feedbackURI, feedbackHash)
2. Fetch canonical bytes from feedbackURI (0G Storage rootHash)
3. JSON.parse, re-canonicalize via canonicalizeAuditReport
4. Compare result.hash to feedbackHash
5. Match → bytes are exactly what auditor agreed to on chain
```

## Data flow — hire scenario (Slice X)

```
1. Operator types: kh hire <slug|id> [<json>]    apps/tui/src/index.ts dispatcher
2. resolveCallableSlug(workflow)                 kh-hire-validate.ts:39
3. validateRequiredInputs(workflow, inputs)      kh-hire-validate.ts:61
4. payViaKeeperHubMarketplace                    @keeperhub/wallet shim
   ├─ HTTP 402 challenge from KH MCP endpoint
   ├─ x402 settlement on Base Sepolia            packages/workflow/src/x402.ts
   │   - EIP-3009 USDC transferWithAuthorization
   │   - settles to FeeSplitter or AgentReceiverWallet
   └─ retry with X-PAYMENT header → workflow run
5. KH returns runId + result                     audit row in TUI
```

Failure modes are typed: `no-slug` (workflow public but not slug-callable),
missing required input (first key surfaced by name), missing
`KH_AUTHOR_*` env (surfaced as the env names, never values).

## Workspace package graph

```
packages/
  workflow ◄── audit-agent, swap-agent, mcp-adapter, demo, tui (live)
  router   ◄── demo, agents (mode classifier optional)
  oracle-data ◄── apps/agents/oracle
  wallet-aa ◄── tui (park/unpark, ERC-4337 hooks)
  ui, env, config (multi-app shared, not on the agent path)

apps/
  agents/audit   = @zhgg/audit-agent     (probe runner, runAudit)
  agents/oracle  = @zhgg/oracle-agent    (regulatory feeds + price)
  zhgg-mcp-adapter = @zhgg/mcp-adapter   (HTTP server, Slice Z)
  keeperhub-agent = @zhgg/keeperhub-agent (KH HTTP client + endpoints)
  swap-agent     = @zhgg/swap-agent       (Uniswap V3, Base Sepolia)
  transfer-agent = @zhgg/transfer-agent   (ERC-20 / native, ENS resolve)
  mint-agent     = @zhgg/mint-agent       (iNFT mint + ENS subname optional)
  tui            = @zhgg/tui              (raw ANSI dashboard)
  demo           = @zhgg/demo             (cross-agent CLI, smoke-test)
  tee-verifier   = @zhgg/tee-verifier     (sidecar :8787 /verify)
  web            = web                    (static homepage; not on agent path)
```

All package names verified via `package.json` files (`1f21343` standardized
the `@zhgg/*` prefix; bare names remain only in `@my-better-t-app/*`
template-baseline packages: `config`, `env`, `ui`).

## Contract deployment map

| Contract | Chain | Deploy script | TS caller |
|---|---|---|---|
| `AgentNFT.sol` (ERC-7857) | 0G Galileo | `Deploy0GContracts.s.sol` | `apps/mint-agent/src/index.ts`, `apps/agents/audit` reader |
| `AgentRegistry.sol` (ERC-8004) | 0G Galileo | `Deploy0GContracts.s.sol` | `packages/workflow/src/erc8004.ts:postReceipt`, `apps/zhgg-mcp-adapter/src/index.ts:130` |
| `AxiomCommit.sol` | 0G Galileo | `Deploy0GContracts.s.sol` | `apps/demo/src/loop-helpers.ts` (commit/reveal) |
| `AgenticCommerce.sol` (ACP / EIP-8183) | 0G Galileo | `Deploy0GContracts.s.sol` | `apps/tui/src/index.ts:1218` (`acp create/release`) |
| `SpendCap.sol` (ERC-7715) | Base Sepolia | `DeployBaseContracts.s.sol` | `packages/workflow/src/x402.ts` (pre-flight gate) |
| `FeeSplitter.sol` (ERC-8021) | Base Sepolia | `DeployBaseContracts.s.sol` | `packages/workflow/src/x402.ts` (settle target), TUI live-feed |
| `OwnerMirror.sol` | Base Sepolia | `DeployBaseContracts.s.sol` | `AgentReceiverWallet.splitMyBalance` reads `ownerOf` |
| `AgentReceiverWalletFactory.sol` | Base Sepolia | `DeployBaseContracts.s.sol` | `apps/tui/src/index.ts:1062` (park/unpark + split) |
| `DelegationManager.sol` (ERC-7710) | Base Sepolia | `DeployBaseContracts.s.sol` | `apps/tui/src/index.ts:799` (delegate intent), `packages/workflow/src/delegation.ts` |
| `AgentSimpleAccountFactory.sol` (ERC-4337) | Base Sepolia | `DeployBaseContracts.s.sol` | `packages/wallet-aa/*` |
| `MockERC4626.sol` (yield) | Base Sepolia | `DeployYieldVault.s.sol` | TUI `park <amt> <USDC|WETH>` via `AgentReceiverWallet.parkIdle` |
| `ENSRegistrar.sol` | mainnet ENS | external (zhgg.eth owner) | `apps/mint-agent/src/index.ts:237` (optional, gated on `ENS_REGISTRAR_ADDRESS`) |

## Env-var matrix

Verified against `.env.example` (181 lines, 31 entries). Required vs
optional per inline comments and `apps/zhgg-mcp-adapter/src/index.ts:69`
boot-env reader.

| Name | Required? | Consumer (file:line) | Purpose |
|---|---|---|---|
| `MINT_AGENT_PRIVATE_KEY` | ✓ | `scripts/fund-zg-router.ts:23`, `apps/tui/src/live-bundle.ts:87`, `apps/mint-agent/src/index.ts` | Master deployer + iNFT-owner key |
| `PRIVATE_KEY` | ✓ alias | `contracts/script/Deploy*.s.sol` (forge env) | Forge-script alias for `MINT_AGENT_PRIVATE_KEY` |
| `ZG_PRIVATE_KEY` | ✓ alias | `apps/zhgg-mcp-adapter/src/index.ts:100` | Audit + KH-pipe signer on 0G |
| `BASE_SEPOLIA_PRIVATE_KEY` | ✓ alias | `apps/transfer-agent/src/index.ts:227`, `apps/zhgg-mcp-adapter/src/index.ts:98` | Swap + transfer + AA signer |
| `ZG_RPC_URL` | ✓ | `packages/router/src/constants.ts:6` (default), `apps/zhgg-mcp-adapter/src/index.ts:101` | 0G Galileo RPC |
| `BASE_SEPOLIA_RPC_URL` | ✓ | `apps/tui/src/live-feed.ts:13`, `apps/transfer-agent/src/index.ts:228` | Base Sepolia RPC |
| `KH_TREASURY` / `ZHGG_TREASURY` / `COMMONS_TREASURY` | ✓ | `DeployBaseContracts.s.sol` | FeeSplitter cuts (5/5/5) |
| `USDC_BASE_SEPOLIA_ADDRESS` | ✓ (preset) | `apps/demo/src/live-deps.ts:451`, `apps/tui/src/live-feed.ts:14` | Circle testnet USDC |
| `AGENT_NFT_ADDRESS` | filled-by-deploy | `apps/tui/src/index.ts:1006`, `apps/demo/src/live-deps.ts:469` | iNFT body |
| `AGENT_REGISTRY_ADDRESS` | filled-by-deploy | `apps/zhgg-mcp-adapter/src/index.ts:103` | ERC-8004 receipts |
| `AXIOM_COMMIT_ADDRESS` | filled-by-deploy | `apps/tui/src/index.ts:462`, `apps/demo/src/live-deps.ts:472` | AxiomCommit (steps 3/10) |
| `ACP_ADDRESS` | filled-by-deploy | `apps/tui/src/index.ts:1218,1268` | EIP-8183 ACP intents |
| `SPEND_CAP_ADDRESS` | filled-by-deploy | `apps/demo/src/live-deps.ts:466` | ERC-7715 cap |
| `FEE_SPLITTER_ADDRESS` | filled-by-deploy | x402 settle target | Direct-split rail |
| `OWNER_MIRROR_ADDRESS` | filled-by-deploy | `AgentReceiverWallet.ownerOf` | iNFT-owner mirror |
| `RECEIVER_FACTORY_ADDRESS` | filled-by-deploy | `apps/tui/src/index.ts:1062`, `apps/mint-agent/src/index.ts:418` | Per-iNFT receiver wallet |
| `DELEGATION_MANAGER_ADDRESS` | filled-by-deploy | `apps/tui/src/index.ts:799` | ERC-7710 redeem |
| `AA_FACTORY_ADDRESS` | filled-by-deploy | `packages/wallet-aa` | ERC-4337 wallet factory |
| `YIELD_VAULT_ADDRESS` | filled-by-deploy | `apps/tui/src/index.ts:1068,1142` | ERC-4626 park/unpark |
| `SMOKE_TOKEN_ID` | smoke input | `apps/demo/src/smoke-test.ts` | iNFT id under test |
| `ZG_ROUTER_KEY` | optional | `apps/demo/src/live-deps.ts:442`, `apps/zhgg-mcp-adapter/src/index.ts:102` | 0G Compute `sk-` key — fail-open |
| `ZG_STORAGE_ENABLED` | optional (`=1`) | `apps/demo/src/live-deps.ts:475`, `packages/workflow/src/audit-report.ts:287` | Enables real Storage Log writes |
| `ZG_INDEXER_RPC` | optional | `apps/demo/src/live-deps.ts:476` | 0G Storage indexer (Turbo) |
| `ANTHROPIC_API_KEY` | optional | classifier (Phase 17) | Mode classifier — fail-open |
| `PIMLICO_API_KEY` | optional | ERC-4337 paymaster (Phase 18) | Mainnet bundler |
| `KH_MARKETPLACE_SLUG` / `KH_AUTHOR_SUBORG_ID` / `KH_AUTHOR_WALLET` / `KH_AUTHOR_HMAC_SECRET` / `KEEPERHUB_API_URL` | optional (all-or-none) | `apps/demo/src/live-deps.ts:457-463`, `apps/tui/src/index.ts:1313-1462` | KeeperHub marketplace settle |
| `KH_API_KEY` | optional | `apps/tui/src/index.ts:1307,1442` | KH discover/inspect (read auth) |
| `ENS_REGISTRAR_ADDRESS` / `ENS_RPC_URL` | optional | `apps/mint-agent/src/index.ts:237`, `apps/tui/src/index.ts:410,770` | ENS subname mint + resolve |
| `TEE_VERIFIER_URL` / `TEE_STRICT` | optional | `apps/tee-verifier/src/server.ts:21`, workflow attestation gate | TEE STRICT verifier sidecar |
| `ACP_FEE_BPS` / `ACP_TREASURY` | optional | ACP deploy + read | EIP-8183 protocol fee |
| `SMOKE_PERMISSION_ID` | optional | smoke test | `bytes32(0)` legacy bucket |
| `MCP_AUTH_TOKEN` | required for Slice Z | `apps/zhgg-mcp-adapter/src/index.ts:341`, `packages/workflow/src/standalone.ts:14` | Bearer for `/agents/*` — empty refuses to boot |
| `MCP_PORT` / `PORT` | optional (default 8080/8787) | `apps/zhgg-mcp-adapter/src/index.ts:71`, `apps/tee-verifier/src/server.ts:21` | HTTP listen ports |
| `OWNER_MIRROR_ATTESTOR` | optional | OwnerMirror admin path | Hot wallet replaying iNFT transfers |
| `DEPLOY_RECEIVER_FACTORY` | optional | `DeployBaseContracts.s.sol` | Toggle factory deploy |
| `ENS_USE_MAINNET` | optional | `apps/mint-agent/src/index.ts` | Mainnet vs Sepolia ENS |

## What's deliberately NOT in this diagram

- LayerZero / Wormhole bridges: not present on Galileo; cross-chain rail is Across (`packages/workflow/src/across.ts`, Base Sepolia SpokePool only).
- Python / Redis / OPA / Macaroons: ruled out in SPEC.md, all paths are TS + bun + viem (+ ethers v6 for the 0G SDK boundary).
- The `web` app: marketing site only, no on-chain calls. Untouched per SPEC "Never" rules.
