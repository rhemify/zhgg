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

  return {
    kind: 'unknown',
    raw: trimmed,
    reason: `unknown intent — try "audit <ens>", "ask oracle <topic>", "swap <amount> <from> <to>", or "transfer <amount> <token> to <recipient>"`,
  };
}
