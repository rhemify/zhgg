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
  | { kind: 'kh-trigger'; workflowId: string; inputs?: Record<string, unknown> }
  | { kind: 'kh-status'; executionId: string }
  | { kind: 'kh-runs'; status?: 'success' | 'error' | 'pending'; range?: '1h' | '24h' | '7d' }
  | { kind: 'kh-cap' }
  /// Operator UX intents (Phase 3). Read-only inspections + the explicit
  /// `mint <role>` write. Each is dispatched directly from the TUI's
  /// keypress handler; none of them touches the orchestrator FLOW panel
  /// because they don't involve audit / payment legs.
  | { kind: 'agents' }
  | { kind: 'balances' }
  | { kind: 'block' }
  | { kind: 'cancel' }
  | { kind: 'mint'; role: MintRole }
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
    if (sub === 'runs') {
      // Form: `kh runs [success|error|pending] [1h|24h|7d]`. Both args
      // are optional; defaults applied at dispatch time.
      const validStatus = new Set(['success', 'error', 'pending']);
      const validRange = new Set(['1h', '24h', '7d']);
      let status: 'success' | 'error' | 'pending' | undefined;
      let range: '1h' | '24h' | '7d' | undefined;
      for (const tok of parts.slice(2)) {
        const t = tok.toLowerCase();
        if (validStatus.has(t)) status = t as typeof status;
        else if (validRange.has(t)) range = t as typeof range;
        else {
          return {
            kind: 'unknown',
            raw: trimmed,
            reason: `kh runs unknown filter "${tok}" — expected status (success|error|pending) or range (1h|24h|7d)`,
          };
        }
      }
      return { kind: 'kh-runs', status, range };
    }
    if (sub === 'cap') {
      if (parts.length > 2) {
        return { kind: 'unknown', raw: trimmed, reason: 'kh cap takes no arguments' };
      }
      return { kind: 'kh-cap' };
    }
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: `kh: unknown sub-verb "${sub}" — supported: trigger, status, runs, cap`,
    };
  }

  return {
    kind: 'unknown',
    raw: trimmed,
    reason: `unknown intent — try "audit <ens>", "ask oracle <topic>", "swap <amount> <from> <to>", "transfer <amount> <token> to <recipient>", or "kh <trigger|status|runs|cap>"`,
  };
}
