/// Tiny shell-style parser for the TUI's intent input.
///
/// Recognised forms:
///   `audit <ens-or-tokenid>`              → kick the cross-agent orchestrator
///   `ask oracle <topic>`                  → standalone oracle query
///   `swap <amount> <from> <to>`           → real on-chain swap via swap-agent
///   `transfer <amount> <token> to <addr>` → real ERC-20 / ETH transfer via
///                                           transfer-agent. Recipient may
///                                           be a 0x address or *.eth name
///                                           (mainnet ENS resolution).
///
/// Anything else returns `{ kind: 'unknown' }` so the caller can render
/// a hint instead of dispatching. We deliberately avoid throwing on bad
/// input — the TUI keeps editing on, the user just sees the
/// "unrecognised" toast and fixes the line.

import type { OracleTopic } from '@zhgg/oracle-data';
import { resolveAgent } from './agent-registry.js';

/// Symbols accepted by the swap-agent (kept in sync with
/// `apps/swap-agent/src/index.ts` SUPPORTED_SYMBOLS). Listed here as a
/// literal-union so the parser can produce a typed value the TUI passes
/// through without re-validating.
export type SwapSymbol = 'ETH' | 'WETH' | 'USDC';

const SWAP_SYMBOLS: ReadonlySet<SwapSymbol> = new Set<SwapSymbol>(['ETH', 'WETH', 'USDC']);

/// Symbols accepted by the yield park/unpark intents (Slice K). The
/// MockERC4626 vault wraps an ERC-20, so native ETH is rejected — the
/// operator must wrap to WETH first via `swap`. USDC is the canonical
/// asset (FeeSplitter path); WETH is allowed for completeness so the
/// same vault contract can be redeployed against WETH for a different
/// demo.
export type ParkSymbol = Extract<SwapSymbol, 'USDC' | 'WETH'>;

const PARK_SYMBOLS: ReadonlySet<ParkSymbol> = new Set<ParkSymbol>(['USDC', 'WETH']);

/// Roles accepted by the `mint <role>` operator intent. Mirrors the
/// `AgentTier` union in `apps/mint-agent/src/index.ts` — kept as a
/// duplicate literal here so the parser can return a typed value
/// without importing the CLI module (the parser is sync; mint-agent
/// pulls in viem clients).
export type MintRole = 'audit' | 'oracle' | 'swap';

const MINT_ROLES: ReadonlySet<MintRole> = new Set<MintRole>(['audit', 'oracle', 'swap']);

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
  | { kind: 'empty' }
  | { kind: 'unknown'; raw: string; reason: string }
  /// Surfaced when the user types an `*.eth` target that isn't in
  /// `agent-registry.ts`. Distinct from `unknown` so the TUI can
  /// render a "mint first" hint instead of the generic command help.
  | { kind: 'unknown_agent'; raw: string; target: string; message: string };

const ORACLE_TOPICS: ReadonlySet<OracleTopic> = new Set<OracleTopic>([
  'eu-ai-act',
  'mica',
  'gdpr-ai',
  'price',
]);

/// Map free-form user phrases to the canonical `OracleTopic` enum so
/// `ask oracle ETH/USD` and `ask oracle price` both reach the same
/// data path. Returns null when the phrase doesn't match anything we
/// know — caller surfaces the supported list as a hint.
function resolveOracleTopic(raw: string): OracleTopic | null {
  const norm = raw.toLowerCase().trim();
  if (norm.length === 0) return null;
  if (ORACLE_TOPICS.has(norm as OracleTopic)) return norm as OracleTopic;
  // Heuristic: anything that looks like a price feed symbol routes to
  // the `price` topic. Caller forwards the raw symbol via the
  // OracleQuery `params` block.
  if (/^[a-z]{2,5}\/[a-z]{2,5}$/i.test(raw)) return 'price';
  if (norm.includes('mica')) return 'mica';
  if (norm.includes('gdpr')) return 'gdpr-ai';
  if (norm.includes('ai-act') || norm.includes('eu')) return 'eu-ai-act';
  return null;
}

/// Resolve an `audit <target>` argument to a real on-chain tokenId.
///
/// Three input shapes:
///   - bare digits (e.g. `7`) → parsed as `BigInt`, passed through.
///   - `*.eth` name → looked up in the static `agent-registry.ts`
///     map; returns `unknown_agent` when missing so the TUI can
///     prompt the user to mint first.
///   - anything else → generic `unknown` reason (caller renders the
///     command-help hint).
///
/// We deliberately removed the previous keccak-style hash fallback —
/// it produced syntactically-valid `bigint`s that no AgentNFT could
/// possibly own, so any downstream `tokenURI` / `ownerOf` read
/// reverted with a confusing "ERC721NonexistentToken" error.
type TargetResolution =
  | { ok: true; tokenId: bigint }
  | { ok: false; cmd: IntentCommand };

function resolveTarget(target: string, raw: string): TargetResolution {
  if (/^\d+$/.test(target)) {
    return { ok: true, tokenId: BigInt(target) };
  }
  if (/\.eth$/i.test(target)) {
    const tokenId = resolveAgent(target);
    if (tokenId === null) {
      return {
        ok: false,
        cmd: {
          kind: 'unknown_agent',
          raw,
          target,
          message: `${target} — not in agent-registry. Mint first or use a tokenId.`,
        },
      };
    }
    return { ok: true, tokenId };
  }
  return {
    ok: false,
    cmd: {
      kind: 'unknown',
      raw,
      reason: `audit target "${target}" — expected an *.eth name or numeric tokenId`,
    },
  };
}

export function parseIntent(input: string): IntentCommand {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { kind: 'empty' };

  // Tokenise on whitespace; multi-word topics like `eu-ai-act` are
  // already hyphenated so the rest of the line is one token. For
  // `ask oracle <multi word>` we join the tail back together.
  const parts = trimmed.split(/\s+/);
  const head = parts[0]?.toLowerCase() ?? '';

  if (head === 'audit') {
    const target = parts[1]?.trim();
    if (!target) {
      return { kind: 'unknown', raw: trimmed, reason: 'audit needs a target (ens or tokenId)' };
    }
    const resolved = resolveTarget(target, trimmed);
    if (!resolved.ok) return resolved.cmd;
    return { kind: 'audit', target, tokenId: resolved.tokenId };
  }

  // ── AxiomCommit intents (Slice H) ────────────────────────────────────
  // `commit <tokenId|ens> <plan-text>` → commitPlan(tokenId, keccak256(plan))
  // `reveal <commitId>     <plan-text>` → revealPlan(tokenId, commitId, plan, "")
  // Plan is rest-of-line, kept verbatim — joining with single spaces is
  // intentional (canonicalises whitespace). For reveal, the tokenId is
  // recovered from the commit on-chain; the dispatcher reads it via
  // commitOf(commitId) before sending the reveal tx.
  if (head === 'commit') {
    const target = parts[1]?.trim();
    if (!target) {
      return { kind: 'unknown', raw: trimmed, reason: 'commit needs <tokenId|ens> <plan>' };
    }
    const plan = parts.slice(2).join(' ').trim();
    if (plan.length === 0) {
      return { kind: 'unknown', raw: trimmed, reason: 'commit plan body is empty' };
    }
    const resolved = resolveTarget(target, trimmed);
    if (!resolved.ok) return resolved.cmd;
    return { kind: 'axiom-commit', target, tokenId: resolved.tokenId, plan };
  }

  if (head === 'reveal') {
    const commitId = parts[1]?.trim() ?? '';
    if (!/^0x[a-fA-F0-9]{64}$/.test(commitId)) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: `reveal commitId "${commitId}" — expected 0x + 64 hex chars`,
      };
    }
    const plan = parts.slice(2).join(' ').trim();
    if (plan.length === 0) {
      return { kind: 'unknown', raw: trimmed, reason: 'reveal plan body is empty' };
    }
    return {
      kind: 'axiom-reveal',
      commitId: commitId as `0x${string}`,
      plan,
    };
  }

  // ── Delegation intent (Slice I — ERC-7710) ───────────────────────────
  // `delegate <to> <permissionId>` — issues a real redeemable delegation
  // via DelegationManager on Base Sepolia. <to> is one of:
  //   - 0x + 40 hex address (validated by viem getAddress in the dispatcher)
  //   - agent ENS like `oracle.zhgg.eth` (resolved via agent-registry →
  //     AgentNFT.ownerOf on 0G Galileo to recover the iNFT owner address)
  //   - mainnet ENS like `vitalik.eth` (resolved via resolveRecipient)
  // <permissionId> MUST be 0x + 64 hex bytes32. We validate the shape
  // here so the dispatcher never has to invent a hint for a typo'd id;
  // a real "permission not granted" path stays available on chain via
  // SpendCap's CapNotFound revert during redeem.
  if (head === 'delegate') {
    const to = parts[1]?.trim() ?? '';
    const permissionId = parts[2]?.trim() ?? '';
    if (!to) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: 'delegate needs <to> <permissionId> (e.g. "delegate oracle.zhgg.eth 0x0000…0001")',
      };
    }
    if (!permissionId) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: 'delegate needs a permissionId (0x + 64 hex bytes32)',
      };
    }
    if (parts.length > 3) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: 'delegate takes exactly two arguments: <to> <permissionId>',
      };
    }
    // Shape-validate <to>: 0x40-hex OR *.eth name. The dispatcher does
    // the real resolution (checksum + ENS lookup); we just reject obvious
    // typos so the operator gets immediate feedback.
    const isAddrShape = /^0x[a-fA-F0-9]{40}$/.test(to);
    const isEnsShape = /\.eth$/i.test(to);
    if (!isAddrShape && !isEnsShape) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: `delegate to "${to}" — expected 0x-address or *.eth name (mainnet ENS or *.zhgg.eth agent)`,
      };
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(permissionId)) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: `delegate permissionId "${permissionId}" — expected 0x + 64 hex chars (bytes32)`,
      };
    }
    return {
      kind: 'delegate',
      to,
      permissionId: permissionId as `0x${string}`,
    };
  }

  // ── Yield-vault intents (Slice K — ERC-4626) ─────────────────────────
  // Two accepted forms — short (defaults tokenId=1) and explicit:
  //   `park <amount> <USDC|WETH>`               e.g. `park 1 USDC`
  //   `park <tokenId> <amount> <USDC|WETH>`     e.g. `park 1 0.5 USDC`
  // Same shapes for `unpark`. Disambiguation: the short form has 2
  // args after the verb; the explicit form has 3. We refuse anything
  // else with a precise hint rather than guessing.
  if (head === 'park' || head === 'unpark') {
    const tokens = parts.slice(1);
    let tokenId: bigint;
    let amount: string;
    let symRaw: string;

    if (tokens.length === 2) {
      tokenId = 1n; // default to seed agent
      amount = tokens[0]!;
      symRaw = tokens[1]!;
    } else if (tokens.length === 3) {
      const tidRaw = tokens[0]!;
      if (!/^\d+$/.test(tidRaw)) {
        return {
          kind: 'unknown',
          raw: trimmed,
          reason: `${head} tokenId "${tidRaw}" — expected positive integer (e.g. 1, 2, 3)`,
        };
      }
      tokenId = BigInt(tidRaw);
      amount = tokens[1]!;
      symRaw = tokens[2]!;
    } else {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: `${head} needs <amount> <USDC|WETH> or <tokenId> <amount> <USDC|WETH> (e.g. "${head} 1 USDC", "${head} 2 0.5 USDC")`,
      };
    }

    if (!/^\d+(\.\d+)?$/.test(amount)) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: `${head} amount "${amount}" — expected decimal (e.g. 1, 0.5)`,
      };
    }
    const symbol = symRaw.toUpperCase();
    if (!PARK_SYMBOLS.has(symbol as ParkSymbol)) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: `${head} symbol "${symRaw}" — supported: USDC, WETH (native ETH not allowed; vault expects ERC-20)`,
      };
    }
    return {
      kind: head === 'park' ? 'park' : 'unpark',
      amount,
      symbol: symbol as ParkSymbol,
      tokenId,
    };
  }

  // ── ACP / EIP-8183 escrow intents (Slice J) ──────────────────────────
  // Two sub-verbs against the deployed AgenticCommerce contract on 0G:
  //   `acp create <agentTokenId|ens> <usdcAmount>` → createJob+fund
  //   `acp release <jobId>`                         → complete (releases
  //                                                    escrow → provider)
  //
  // agentTokenId follows the same digits-or-ENS resolution as `audit`.
  // usdcAmount is a decimal-string in the payment token's units (the
  // dispatcher applies parseUnits(_, 6) and reads the actual token
  // address from ACP_PAYMENT_TOKEN env). jobId is bare uint256 digits.
  //
  // Refusals are surfaced as `unknown` with a precise reason — the
  // dispatcher only ever sees a well-formed `acp-create` / `acp-release`.
  if (head === 'acp') {
    const sub = parts[1]?.toLowerCase();
    if (!sub) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: 'acp needs a sub-verb: create | release',
      };
    }
    if (sub === 'create') {
      const target = parts[2]?.trim();
      const amount = parts[3]?.trim();
      if (!target || !amount) {
        return {
          kind: 'unknown',
          raw: trimmed,
          reason: 'acp create needs <agentTokenId|ens> <usdcAmount> (e.g. "acp create oracle.zhgg.eth 0.5")',
        };
      }
      if (parts.length > 4) {
        return {
          kind: 'unknown',
          raw: trimmed,
          reason: 'acp create takes exactly two arguments: <agentTokenId|ens> <usdcAmount>',
        };
      }
      // Decimal shape — same regex as swap/transfer so the dispatcher's
      // parseUnits(_, 6) call never throws on user-typed input.
      if (!/^\d+(\.\d+)?$/.test(amount)) {
        return {
          kind: 'unknown',
          raw: trimmed,
          reason: `acp create amount "${amount}" — expected decimal USDC (e.g. 0.5, 10, 100.25)`,
        };
      }
      // Reject zero-budget early — the contract reverts with ZeroBudget()
      // on fund(); we can save the round trip and surface a clearer hint.
      if (/^0(\.0+)?$/.test(amount)) {
        return {
          kind: 'unknown',
          raw: trimmed,
          reason: 'acp create amount "0" — escrow must be > 0 (contract reverts ZeroBudget)',
        };
      }
      const resolved = resolveTarget(target, trimmed);
      if (!resolved.ok) return resolved.cmd;
      return { kind: 'acp-create', target, tokenId: resolved.tokenId, usdcAmount: amount };
    }
    if (sub === 'release') {
      const jobIdRaw = parts[2]?.trim();
      if (!jobIdRaw) {
        return {
          kind: 'unknown',
          raw: trimmed,
          reason: 'acp release needs <jobId> (e.g. "acp release 1")',
        };
      }
      if (parts.length > 3) {
        return {
          kind: 'unknown',
          raw: trimmed,
          reason: 'acp release takes exactly one argument: <jobId>',
        };
      }
      // Plain uint256 digits only — leading zeros, signs, and hex are
      // all rejected. Real jobIds are monotonic from 1.
      if (!/^[0-9]+$/.test(jobIdRaw)) {
        return {
          kind: 'unknown',
          raw: trimmed,
          reason: `acp release jobId "${jobIdRaw}" — expected uint256 digits (e.g. 1, 42)`,
        };
      }
      const jobId = BigInt(jobIdRaw);
      if (jobId === 0n) {
        return {
          kind: 'unknown',
          raw: trimmed,
          reason: 'acp release jobId "0" — jobIds start at 1',
        };
      }
      return { kind: 'acp-release', jobId };
    }
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: `acp: unknown sub-verb "${sub}" — supported: create, release`,
    };
  }

  if (head === 'swap') {
    // Accept compact OR natural-language forms:
    //   `swap 0.001 ETH USDC`        ← compact
    //   `swap 0.001 ETH to USDC`     ← natural
    //   `swap 0.001 ETH for USDC`    ← natural
    //   `swap 0.001 ETH -> USDC`     ← arrow
    // Filler tokens are stripped before extracting <amount> <from> <to>.
    const FILLERS = new Set(['from', 'to', 'for', 'into', '->', '→']);
    const tokens = parts.slice(1).filter((t) => !FILLERS.has(t.toLowerCase()));
    if (tokens.length !== 3) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: 'swap needs <amount> <fromSym> <toSym> (e.g. "swap 0.001 ETH USDC" or "swap 0.001 ETH to USDC")',
      };
    }
    const amount = tokens[0]!;
    const fromRaw = tokens[1]!;
    const toRaw = tokens[2]!;

    // ENS-shaped string in a symbol slot is a clear sign the user wanted
    // a transfer (send tokens to an address), not a swap (exchange one
    // token for another). Surface that distinction explicitly.
    if (/\.eth$/i.test(fromRaw) || /\.eth$/i.test(toRaw)) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: 'swap exchanges TOKENS not addresses. ENS in symbol slot suggests you wanted to TRANSFER funds to that address — that intent is not wired yet. For a swap, use ETH/WETH/USDC.',
      };
    }

    if (!/^\d+(\.\d+)?$/.test(amount)) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: `swap amount "${amount}" — expected decimal (e.g. 0.001, 5)`,
      };
    }
    const fromSym = fromRaw.toUpperCase();
    const toSym = toRaw.toUpperCase();
    if (!SWAP_SYMBOLS.has(fromSym as SwapSymbol)) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: `swap fromSym "${fromRaw}" — supported: ETH, WETH, USDC`,
      };
    }
    if (!SWAP_SYMBOLS.has(toSym as SwapSymbol)) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: `swap toSym "${toRaw}" — supported: ETH, WETH, USDC`,
      };
    }
    if (fromSym === toSym) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: `swap fromSym and toSym are identical (${fromSym})`,
      };
    }
    return {
      kind: 'swap',
      amount,
      fromSym: fromSym as SwapSymbol,
      toSym: toSym as SwapSymbol,
    };
  }

  if (head === 'transfer' || head === 'send' || head === 'pay') {
    // Form: `transfer <amount> <symbol> [to] <recipient>`
    // Filler tokens like `to` / `into` / `→` are stripped so users can
    // type the natural-language version. We also accept `send` and
    // `pay` as aliases — same semantics, different vocabulary.
    const FILLERS = new Set(['to', 'into', '->', '→']);
    const tokens = parts.slice(1).filter((t) => !FILLERS.has(t.toLowerCase()));
    if (tokens.length !== 3) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: 'transfer needs <amount> <symbol> <recipient> (e.g. "transfer 1 USDC vitalik.eth" or "transfer 0.001 ETH to 0xAbc…")',
      };
    }
    const amount = tokens[0]!;
    const symRaw = tokens[1]!;
    const recipient = tokens[2]!;

    if (!/^\d+(\.\d+)?$/.test(amount)) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: `transfer amount "${amount}" — expected decimal (e.g. 0.001, 5)`,
      };
    }
    const symbol = symRaw.toUpperCase();
    if (!SWAP_SYMBOLS.has(symbol as SwapSymbol)) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: `transfer symbol "${symRaw}" — supported: ETH, WETH, USDC`,
      };
    }
    // Cheap recipient sanity-check: 0x40-hex OR *.eth shape. Real
    // validation/resolution happens inside the agent (viem getAddress +
    // ENS lookup) — here we just reject obvious typos so the user gets
    // immediate feedback before the dispatch round-trip.
    const isAddrShape = /^0x[a-fA-F0-9]{40}$/.test(recipient);
    const isEnsShape = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+\.eth$/i.test(recipient) ||
                       /^[a-z0-9_-]+\.eth$/i.test(recipient);
    if (!isAddrShape && !isEnsShape) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: `transfer recipient "${recipient}" — expected 0x-address or *.eth name`,
      };
    }
    return {
      kind: 'transfer',
      amount,
      symbol: symbol as SwapSymbol,
      recipient,
    };
  }

  if (head === 'ask' && parts[1]?.toLowerCase() === 'oracle') {
    const tail = parts.slice(2).join(' ').trim();
    if (tail.length === 0) {
      return { kind: 'unknown', raw: trimmed, reason: 'ask oracle needs a topic (eu-ai-act, mica, gdpr-ai, price, ETH/USD)' };
    }
    const topic = resolveOracleTopic(tail);
    if (!topic) {
      return { kind: 'unknown', raw: trimmed, reason: `unknown oracle topic "${tail}"` };
    }
    return { kind: 'ask-oracle', topic, raw: tail };
  }

  // ── Operator UX intents (Phase 3) ─────────────────────────────────────
  // Single-word verbs first — none take arguments. `mint <role>` is the
  // only multi-token form; the role must be one of {audit, oracle, swap}.
  if (head === 'agents' && parts.length === 1)   return { kind: 'agents' };
  if (head === 'balances' && parts.length === 1) return { kind: 'balances' };
  if (head === 'block' && parts.length === 1)    return { kind: 'block' };
  if (head === 'cancel' && parts.length === 1)   return { kind: 'cancel' };

  if (head === 'mint') {
    const role = parts[1]?.toLowerCase();
    if (!role) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: 'mint needs a role: audit | oracle | swap',
      };
    }
    if (!MINT_ROLES.has(role as MintRole)) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: `mint role "${role}" — supported: audit, oracle, swap`,
      };
    }
    if (parts.length > 2) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: 'mint takes exactly one argument: the role',
      };
    }
    return { kind: 'mint', role: role as MintRole };
  }

  // ── KeeperHub direct-API intents (Phase 2) ───────────────────────────
  // Form: `kh <sub> [args]`. The sub-verb selects an `executeKHCall`
  // shape; arg parsing is permissive — invalid args surface as
  // `unknown` with a precise reason rather than a typed call (so the
  // user gets immediate feedback before the dispatcher round-trips).
  if (head === 'kh') {
    const sub = parts[1]?.toLowerCase();
    if (!sub) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: 'kh needs a sub-verb: trigger | status | runs | cap',
      };
    }
    if (sub === 'trigger') {
      const workflowId = parts[2];
      if (!workflowId) {
        return {
          kind: 'unknown',
          raw: trimmed,
          reason: 'kh trigger needs <workflowId> [<jsonInputs>]',
        };
      }
      // Inputs (optional): everything after the workflowId is rejoined
      // and parsed as JSON. We require an object at the top level so the
      // KH `inputs` payload contract holds; arrays / scalars are
      // surfaced as `unknown` with the parse error verbatim.
      let inputs: Record<string, unknown> | undefined;
      if (parts.length > 3) {
        const inputsRaw = parts.slice(3).join(' ');
        try {
          const v = JSON.parse(inputsRaw);
          if (typeof v !== 'object' || v === null || Array.isArray(v)) {
            return {
              kind: 'unknown',
              raw: trimmed,
              reason: `kh trigger inputs must be a JSON object, got ${Array.isArray(v) ? 'array' : typeof v}`,
            };
          }
          inputs = v as Record<string, unknown>;
        } catch (e) {
          return {
            kind: 'unknown',
            raw: trimmed,
            reason: `kh trigger inputs JSON parse error: ${(e as Error).message}`,
          };
        }
      }
      return { kind: 'kh-trigger', workflowId, inputs };
    }
    if (sub === 'status') {
      const executionId = parts[2];
      if (!executionId) {
        return { kind: 'unknown', raw: trimmed, reason: 'kh status needs <executionId>' };
      }
      if (parts.length > 3) {
        return { kind: 'unknown', raw: trimmed, reason: 'kh status takes exactly one argument' };
      }
      return { kind: 'kh-status', executionId };
    }
    if (sub === 'workflows') {
      if (parts.length > 2) {
        return { kind: 'unknown', raw: trimmed, reason: 'kh workflows takes no arguments' };
      }
      return { kind: 'kh-workflows' };
    }
    if (sub === 'integrations') {
      if (parts.length > 2) {
        return { kind: 'unknown', raw: trimmed, reason: 'kh integrations takes no arguments' };
      }
      return { kind: 'kh-integrations' };
    }
    if (sub === 'runs' || sub === 'cap') {
      // Endpoints documented in kh-api.md but NOT deployed for kh_ bearer
      // (verified live 2026-05-02 — both 401/404 on app.keeperhub.com).
      // Surface this honestly so the operator doesn't waste time.
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: `kh ${sub} — endpoint not deployed for kh_ bearer auth on app.keeperhub.com. Use 'kh workflows' or 'kh integrations' instead.`,
      };
    }
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: `kh: unknown sub-verb "${sub}" — supported: trigger, status, workflows, integrations`,
    };
  }

  return {
    kind: 'unknown',
    raw: trimmed,
    reason: `unknown intent — try "audit <ens>", "ask oracle <topic>", "swap <amount> <from> <to>", "transfer <amount> <token> to <recipient>", "commit <tokenId> <plan>", "reveal <commitId> <plan>", or "kh <trigger|status|workflows|integrations>"`,
  };
}
