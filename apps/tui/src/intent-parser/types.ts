/// IntentCommand union + symbol types — the typed surface every
/// parser arm produces. Kept separate from the parser dispatcher so
/// other modules (dispatch, format, helpers) can `import type` the
/// shape without dragging in any parsing logic.

import type { OracleTopic } from '@zhgg/oracle-data';

/// Symbols accepted by the swap-agent (kept in sync with
/// `apps/swap-agent/src/index.ts` SUPPORTED_SYMBOLS). Listed here as a
/// literal-union so the parser can produce a typed value the TUI passes
/// through without re-validating.
export type SwapSymbol = 'ETH' | 'WETH' | 'USDC';

export const SWAP_SYMBOLS: ReadonlySet<SwapSymbol> = new Set<SwapSymbol>(['ETH', 'WETH', 'USDC']);

/// Symbols accepted by the yield park/unpark intents (Slice K). The
/// MockERC4626 vault wraps an ERC-20, so native ETH is rejected — the
/// operator must wrap to WETH first via `swap`. USDC is the canonical
/// asset (FeeSplitter path); WETH is allowed for completeness so the
/// same vault contract can be redeployed against WETH for a different
/// demo.
export type ParkSymbol = Extract<SwapSymbol, 'USDC' | 'WETH'>;

export const PARK_SYMBOLS: ReadonlySet<ParkSymbol> = new Set<ParkSymbol>(['USDC', 'WETH']);

/// Roles accepted by the `mint <role>` operator intent. Mirrors the
/// `AgentTier` union in `apps/mint-agent/src/index.ts` — kept as a
/// duplicate literal here so the parser can return a typed value
/// without importing the CLI module (the parser is sync; mint-agent
/// pulls in viem clients).
export type MintRole = 'audit' | 'oracle' | 'swap';

export const MINT_ROLES: ReadonlySet<MintRole> = new Set<MintRole>(['audit', 'oracle', 'swap']);

export type IntentCommand =
  | {
      kind: 'audit';
      /// Either an ENS-shaped string (e.g. `oracle.zhgg.eth`) or a
      /// numeric tokenId. We surface both so the TUI can label the
      /// audit panel ("auditing oracle.zhgg.eth (#7)") without making
      /// the orchestrator chase ENS.
      target: string;
      tokenId: bigint;
    }
  | { kind: 'ask-oracle'; topic: OracleTopic; raw: string }
  | {
      kind: 'swap';
      /// Decimal-string amount expressed in the from-symbol's UNITS
      /// (e.g. "0.001" for 0.001 ETH, "5" for 5 USDC). The agent
      /// converts to atomic units via parseUnits + TOKEN_DECIMALS.
      amount: string;
      fromSym: SwapSymbol;
      toSym: SwapSymbol;
    }
  | {
      kind: 'transfer';
      /// Decimal-string amount in the symbol's units. The transfer-agent
      /// converts to atomic via parseUnits + TOKEN_DECIMALS.
      amount: string;
      symbol: SwapSymbol;
      /// Raw recipient — 0x address OR *.eth name. The transfer-agent
      /// validates / resolves; we keep the user's literal here for the
      /// TUI label ("transferring 1 USDC → vitalik.eth").
      recipient: string;
    }
  /// KeeperHub direct-API intents (Phase 2). Each maps 1:1 to an
  /// `executeKHCall` shape in `keeperhub-agent`. The bearer
  /// (`KH_API_KEY`) is read by the agent itself — never surfaced here.
  /// Endpoint surface confirmed by live probe (2026-05-02): only the
  /// four below work for `kh_` org bearer; analytics/runs and
  /// analytics/spend-cap return 401/404 on app.keeperhub.com.
  | { kind: 'kh-trigger'; workflowId: string; inputs?: Record<string, unknown> }
  | { kind: 'kh-status'; executionId: string }
  | { kind: 'kh-workflows' }
  | { kind: 'kh-integrations' }
  /// Marketplace discovery — `/api/mcp/workflows` returns all publicly-
  /// listed workflows across every KH org. As of probe 2026-05-02 this
  /// surfaces ≈85 entries with full inputSchema + price metadata, which
  /// turns the TUI into a discovery + delegation surface (an iNFT can
  /// list services, pick one matching its capability gap, and pay-and-
  /// trigger via x402). `kh inspect` narrows to one entry for full detail.
  | { kind: 'kh-discover'; search?: string }
  | { kind: 'kh-inspect'; workflowId: string }
  /// Slice X — `kh hire <slugOrId> [<jsonInputs>]`: closes the
  /// agentic-commerce loop by paying via x402 and invoking the
  /// MCP-callable workflow at `/api/mcp/workflows/<slug>/call`.
  /// The dispatcher first runs `kh inspect <slugOrId>` to read the
  /// workflow's `listedSlug`, `priceUsdcPerCall`, and `inputSchema`,
  /// validates required[] keys, then settles via
  /// `payViaKeeperHubMarketplace`. Refuses honestly when:
  ///   - the workflow is discoverable but has `listedSlug === null`
  ///     (not yet slug-callable),
  ///   - any required input key is missing,
  ///   - the buyer wallet config (Turnkey-custodied) is not set in env.
  | { kind: 'kh-hire'; slugOrId: string; inputs?: Record<string, unknown> }
  /// Operator UX intents (Phase 3). Read-only inspections + the explicit
  /// `mint <role>` write. Each is dispatched directly from the TUI's
  /// keypress handler; none of them touches the orchestrator FLOW panel
  /// because they don't involve audit / payment legs.
  | { kind: 'agents' }
  | { kind: 'balances' }
  | { kind: 'block' }
  | { kind: 'cancel' }
  | { kind: 'mint'; role: MintRole }
  /// ACP / ERC-8183 escrow intents (Slice J). Both fire REAL on-chain
  /// transactions against the deployed AgenticCommerce contract on 0G
  /// Galileo (chainId 16602). `acp create` opens a job AND funds it in
  /// three txs (createJob → approve → fund); the user is the client and
  /// is set as the evaluator too (self-evaluating workflow allowed by
  /// the contract — evaluator==zero is rewritten to msg.sender). The
  /// provider is resolved from AgentNFT.ownerOf(tokenId). `acp release`
  /// calls AgenticCommerce.complete(jobId, reason) — only the evaluator
  /// may call, so the same wallet that created the job must release it.
  ///
  /// Amount semantics: `usdcAmount` is decimal-string in the payment
  /// token's units (parsed via parseUnits with 6 decimals — matches the
  /// USDC convention; the actual ACP_PAYMENT_TOKEN address is read from
  /// env at dispatch time and any 6-decimals ERC-20 will work).
  | {
      kind: 'acp-create';
      /// Either an ENS-shaped string (e.g. `oracle.zhgg.eth`) or a
      /// numeric tokenId. We keep both so the dispatcher can label the
      /// audit row with the operator's input verbatim while feeding the
      /// canonical bigint to AgentNFT.ownerOf.
      target: string;
      tokenId: bigint;
      /// Decimal-string amount (e.g. "10", "0.5"). The dispatcher
      /// converts to atomic units via parseUnits(amount, 6).
      usdcAmount: string;
    }
  | {
      kind: 'acp-release';
      /// uint256 jobId. Bare digits only — jobIds are monotonic counters
      /// scoped to AgenticCommerce and don't naturally map to a name.
      jobId: bigint;
    }
  /// AxiomCommit intents (Slice H). Both fire REAL on-chain
  /// `commitPlan` / `revealPlan` calls against the deployed contract on
  /// 0G Galileo (chainId 16602). The `tokenId` is parsed identically to
  /// `audit` (digits or *.eth via resolveAgent); `plan` is rest-of-line
  /// kept verbatim — the dispatcher hashes it via keccak256(toHex(plan))
  /// to mirror what off-chain audit indexers expect.
  | {
      kind: 'axiom-commit';
      target: string;
      tokenId: bigint;
      plan: string;
    }
  | {
      kind: 'axiom-reveal';
      /// 0x + 64 hex commit handle returned by the original commitPlan tx.
      /// Validated at parse time so the dispatcher never sees a malformed
      /// id (the on-chain CommitNotFound revert path is reserved for
      /// genuine "no such commit" cases, not typo'd input).
      commitId: `0x${string}`;
      plan: string;
    }
  /// Yield-vault intents (Slice K — ERC-4626). Both target the user's
  /// AgentReceiverWallet for `tokenId` (default #1). `park` calls
  /// `parkIdle()` on the receiver — anyone-may-call, deposits any idle
  /// balance of the configured `yieldAsset` into the MockERC4626.
  /// `unpark` calls `withdrawIdle(assets)` — owner-only, redeems a
  /// specific atomic amount back from the vault into the receiver.
  /// Native ETH is rejected; the vault always wraps an ERC-20.
  | {
      kind: 'park';
      /// Decimal-string amount in the symbol's units (e.g. "1" for 1
      /// USDC, "0.5" for 0.5 WETH). The dispatcher uses this to
      /// pre-check the receiver wallet's balance and label the audit
      /// row — `parkIdle()` itself deposits the FULL idle balance, so
      /// the operator should fund the receiver with at least this much
      /// before dispatching.
      amount: string;
      symbol: ParkSymbol;
      /// iNFT this wallet serves. Defaults to 1 (the seed agent) when
      /// the operator omits it; explicit form `park 2 0.5 USDC` lets a
      /// power user pick a specific iNFT's receiver.
      tokenId: bigint;
    }
  | {
      kind: 'unpark';
      /// Decimal-string amount in the symbol's units. Unlike park,
      /// unpark uses this exactly: `withdrawIdle(parseUnits(amount,
      /// decimals))` redeems precisely that asset amount from the
      /// vault, burning the proportional share count.
      amount: string;
      symbol: ParkSymbol;
      tokenId: bigint;
    }
  /// Delegation intent (Slice I — ERC-7710). Issues a real redeemable
  /// delegation via the deployed `DelegationManager` on Base Sepolia
  /// (chainId 84532). The dispatcher signs a `Delegation` struct
  /// (caveats are hardcoded — allowedTargets=[SpendCap],
  /// maxValuePerCall=0, expiresAt=now+1h, spendCapAsset=USDC,
  /// permissionId=<intent.permissionId>) via EIP-712, ABI-encodes it
  /// as a permissionContext, and calls `redeemDelegations(...)` on the
  /// manager. Every redemption auto-debits the matching SpendCap
  /// permissionId bucket.
  ///
  /// `to` is the delegate address — kept as a raw string here because
  /// the dispatcher resolves three shapes: bare 0x address (viem
  /// getAddress), agent ENS (`*.zhgg.eth` via agent-registry →
  /// AgentNFT.ownerOf on 0G Galileo), or mainnet ENS (`*.eth` via
  /// resolveRecipient). Validation at parse time is shape-only; real
  /// resolution happens in the dispatcher with full clients.
  | {
      kind: 'delegate';
      /// Raw `<to>` token — 0x-address, agent ENS, or mainnet ENS.
      to: string;
      /// 0x + 64 hex bytes32 — the SpendCap permissionId bucket the
      /// delegation will debit on each redemption. Validated at parse
      /// time so the dispatcher never sees a malformed id.
      permissionId: `0x${string}`;
    }
  /// AA / ERC-4337 intent (Slice — AgentSimpleAccountFactory). Predicts +
  /// deploys a SimpleAccount via `factory.createAccount(owner, salt)` on
  /// Base Sepolia. Idempotent — calling twice returns the same address.
  /// `salt` defaults to `bytes32(0)` (the canonical first account for an
  /// owner); explicit `<0x..64hex>` lets the operator stamp out additional
  /// AA addresses controlled by the same EOA.
  | {
      kind: 'aa-deploy';
      /// 0x + 40 hex (20-byte address), case preserved so the dispatcher
      /// can echo the operator's literal back without checksumming.
      owner: `0x${string}`;
      /// 0x + 64 hex (bytes32). Defaults to all zeros when omitted.
      salt: `0x${string}`;
    }
  | { kind: 'empty' }
  | { kind: 'unknown'; raw: string; reason: string }
  /// Surfaced when the user types an `*.eth` target that isn't in
  /// `agent-registry.ts`. Distinct from `unknown` so the TUI can
  /// render a "mint first" hint instead of the generic command help.
  | { kind: 'unknown_agent'; raw: string; target: string; message: string };
