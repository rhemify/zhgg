# Integration Map

> Last verified: 2026-05-03 against branch `siewwin`.

Workspace package graph + the deployed-contract-to-TS-caller map. Source
of truth: live `from '@zhgg/...'` imports under `apps/` and `packages/`
(scanned via `grep -rn "from '@zhgg"`).

## Package import edges (`@zhgg/*` only)

```
@zhgg/router         ◄── @zhgg/demo (demo/src/agent.ts, headlines.ts, wire.ts)

@zhgg/oracle-data    ◄── @zhgg/tui (intent-parser/{resolve,types}.ts)
                     ◄── @zhgg/oracle-agent (re-export from agents/oracle/index.ts)
                     ◄── @zhgg/workflow (plugins/oracle/steps/query.ts)

@zhgg/oracle-agent   ◄── @zhgg/demo (cross-agent.ts)
                     ◄── @zhgg/tui  (index.ts:46)
                     ◄── @zhgg/mcp-adapter (routes/oracle.ts)

@zhgg/audit-agent    ◄── @zhgg/demo (cross-agent.ts, cross-agent-cli.ts, live-deps.ts)
                     ◄── @zhgg/mcp-adapter (index.ts, routes/audit.ts)

@zhgg/swap-agent     ◄── @zhgg/tui (index.ts:47)
                     ◄── @zhgg/mcp-adapter (index.ts:45, routes/swap.ts)

@zhgg/transfer-agent ◄── @zhgg/tui (index.ts:48)

@zhgg/mint-agent     ◄── @zhgg/tui (operator-intents.ts:24)

@zhgg/keeperhub-agent◄── @zhgg/tui (index.ts:54, kh-hire-validate.ts:19)

@zhgg/workflow       ◄── @zhgg/demo (cross-agent.ts, cross-agent-cli.ts, live-deps.ts)
                     ◄── @zhgg/tui  (index.ts:106)
                     ◄── @zhgg/mcp-adapter (index.ts:43, routes/audit.ts)
                     ◄── @zhgg/audit-agent (agents/audit/src/index.ts:15)
   subpath:
   @zhgg/workflow/storage-log-zg
                     ◄── @zhgg/demo (live-deps.ts:34) — keeps ethers v6 + 0G SDK
                                                       boundary out of the main
                                                       workflow import graph
```

Apps that don't import any `@zhgg/*`: `@zhgg/tee-verifier` (sidecar HTTP
server, self-contained), `web` (static homepage). `@zhgg/wallet-aa` is
declared but not currently imported by other apps (ERC-4337 hook scaffolding).

Template-baseline packages (`@my-better-t-app/{config,env,ui}`) are
infra-only — not on the agent path. Renamed `1f21343` standardized only
the project-specific packages to `@zhgg/*`.

## Deployed-contract → TS caller map

Verified against `apps/*/src` and `packages/workflow/src`. Each row names
the contract, deploy script, and the call site. Empty cells = primitive
not currently exercised by any TS path.

| Contract | Deploy | Read callers | Write callers |
|---|---|---|---|
| `AgentNFT.sol` | `Deploy0GContracts.s.sol` | `apps/tui/src/index.ts:1006` `readAgentCapabilities`; `apps/demo/src/loop-helpers.ts` | `apps/mint-agent/src/index.ts` (`mint`) |
| `AgentRegistry.sol` (ERC-8004) | `Deploy0GContracts.s.sol` | regulator scans `NewFeedback` events | `packages/workflow/src/erc8004.ts` `postReceipt`; `apps/zhgg-mcp-adapter/src/index.ts:130` `giveFeedback` |
| `AxiomCommit.sol` | `Deploy0GContracts.s.sol` | — | `apps/demo/src/loop-helpers.ts` `commitPlan`/`revealPlan`; `apps/tui/src/index.ts:462` (`axiom-commit`/`axiom-reveal` intents) |
| `AgenticCommerce.sol` (ACP / EIP-8183) | `Deploy0GContracts.s.sol` | — | `apps/tui/src/index.ts:1218,1268` (`acp create`/`acp release`) |
| `SpendCap.sol` (ERC-7715) | `DeployBaseContracts.s.sol` | `packages/workflow/src/x402.ts` pre-flight `permissionOf`; smoke-test | `packages/workflow/src/x402.ts` `spendPermission` |
| `FeeSplitter.sol` (ERC-8021) | `DeployBaseContracts.s.sol` | `apps/tui/src/live-feed.ts` event listener | `packages/workflow/src/x402.ts` (settle target via calldata-suffix); orchestrator direct `splitERC20Erc8021` |
| `OwnerMirror.sol` | `DeployBaseContracts.s.sol` | `AgentReceiverWallet.splitMyBalance` reads `ownerOf` | `cast send setOwner` (manual + attestor flow) |
| `AgentReceiverWallet.sol` | per-iNFT via factory | balance reads | `apps/tui/src/index.ts:1062,1136` `splitMyBalance`/`parkIdle`/`withdrawIdle` |
| `AgentReceiverWalletFactory.sol` | `DeployBaseContracts.s.sol` | predict via CREATE2 | `apps/mint-agent/src/index.ts:418` deploy-receiver; TUI auto-deploy on first park |
| `DelegationManager.sol` (ERC-7710) | `DeployBaseContracts.s.sol` | — | `apps/tui/src/index.ts:799` `delegate` intent; helper in `packages/workflow/src/delegation.ts` (build/sign/encode) |
| `AgentSimpleAccount.sol` + factory (ERC-4337) | `DeployBaseContracts.s.sol` | — | `packages/wallet-aa` (Phase 18b stub for paymaster badge) |
| `MockERC4626.sol` | `DeployYieldVault.s.sol` | TUI live-feed yield panel | TUI `park`/`unpark` via `AgentReceiverWallet.parkIdle`/`withdrawIdle` (`apps/tui/src/index.ts:1068,1142`) |
| `ENSRegistrar.sol` (mainnet ENS subname) | external (zhgg.eth owner) | `apps/tui/src/index.ts:770` `resolveRecipient` | `apps/mint-agent/src/index.ts:237` (gated on `ENS_REGISTRAR_ADDRESS`) |

## External integration call sites

| External | Consumer (file:line) | Purpose |
|---|---|---|
| 0G Compute Router (testnet URL `router-api-testnet.integratenetwork.work/v1`) | `packages/workflow/src/adapters/zg-router.ts:18` `inferZG` | TEE inference, `verify_tee: true` |
| 0G Storage indexer (Turbo) | `packages/workflow/src/storage-log-zg.ts` | Log uploads via `@0gfoundation/0g-ts-sdk` |
| 0G Compute ledger (broker SDK) | `scripts/fund-zg-router.ts` | One-shot 3 OG deposit |
| KeeperHub `/api/mcp/workflows` | `apps/keeperhub-agent/src/endpoints/discover.ts` | Marketplace discovery (paginated, 27 entries) |
| KeeperHub `/api/workflows/public` | inspect endpoint | 85-entry broader catalog |
| KeeperHub x402 `<slug>/call` | `@keeperhub/wallet` shim → `payViaKeeperHubMarketplace` | Pay-and-trigger (Slice X) |
| Across SpokePool `0x82B5…0F8F` (Base Sepolia) | `packages/workflow/src/across.ts` | Cross-chain optional slice (Phase 18a) |
| Pyth Hermes | `apps/demo/src/smoke-test.ts` | Price feed for ETH/USD pre-check |
| Anthropic API (Haiku 4.5, optional) | `packages/router/src/classifier.ts` | Mode classifier, fail-open |
| Pimlico bundler (optional) | `packages/wallet-aa` | ERC-4337 paymaster path |
