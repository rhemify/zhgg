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

import type { IntentCommand } from './types.js';
import { parseAudit } from './parsers/audit.js';
import { parseAxiomCommit, parseAxiomReveal } from './parsers/axiom.js';
import { parseDelegate } from './parsers/delegate.js';
import { parsePark } from './parsers/park.js';
import { parseAcp } from './parsers/acp.js';
import { parseSwap } from './parsers/swap.js';
import { parseTransfer } from './parsers/transfer.js';
import { parseAskOracle } from './parsers/ask-oracle.js';
import { parseMint } from './parsers/mint.js';
import { parseKh } from './parsers/kh.js';
import { parseAa } from './parsers/aa.js';

export type {
  IntentCommand,
  SwapSymbol,
  ParkSymbol,
  MintRole,
} from './types.js';

export function parseIntent(input: string): IntentCommand {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { kind: 'empty' };

  // Tokenise on whitespace; multi-word topics like `eu-ai-act` are
  // already hyphenated so the rest of the line is one token. For
  // `ask oracle <multi word>` we join the tail back together.
  const parts = trimmed.split(/\s+/);
  const head = parts[0]?.toLowerCase() ?? '';

  if (head === 'audit') return parseAudit(parts, trimmed);

  // ── AxiomCommit intents (Slice H) ────────────────────────────────────
  if (head === 'commit') return parseAxiomCommit(parts, trimmed);
  if (head === 'reveal') return parseAxiomReveal(parts, trimmed);

  // ── Delegation intent (Slice I — ERC-7710) ───────────────────────────
  if (head === 'delegate') return parseDelegate(parts, trimmed);

  // ── Yield-vault intents (Slice K — ERC-4626) ─────────────────────────
  if (head === 'park' || head === 'unpark') return parsePark(head, parts, trimmed);

  // ── ACP / EIP-8183 escrow intents (Slice J) ──────────────────────────
  if (head === 'acp') return parseAcp(parts, trimmed);

  if (head === 'swap') return parseSwap(parts, trimmed);

  if (head === 'transfer' || head === 'send' || head === 'pay') {
    return parseTransfer(parts, trimmed);
  }

  if (head === 'ask' && parts[1]?.toLowerCase() === 'oracle') {
    return parseAskOracle(parts, trimmed);
  }

  // ── Operator UX intents (Phase 3) ─────────────────────────────────────
  // Single-word verbs first — none take arguments. `mint <role>` is the
  // only multi-token form; the role must be one of {audit, oracle, swap}.
  if (head === 'agents' && parts.length === 1)   return { kind: 'agents' };
  if (head === 'balances' && parts.length === 1) return { kind: 'balances' };
  if (head === 'block' && parts.length === 1)    return { kind: 'block' };
  if (head === 'cancel' && parts.length === 1)   return { kind: 'cancel' };

  if (head === 'mint') return parseMint(parts, trimmed);

  // ── KeeperHub direct-API intents (Phase 2) ───────────────────────────
  if (head === 'kh') return parseKh(parts, trimmed);

  // ── ERC-4337 AgentSimpleAccountFactory intent ────────────────────────
  if (head === 'aa') return parseAa(parts, trimmed);

  return {
    kind: 'unknown',
    raw: trimmed,
    reason: `unknown intent — try "audit <ens>", "ask oracle <topic>", "swap <amount> <from> <to>", "transfer <amount> <token> to <recipient>", "commit <tokenId> <plan>", "reveal <commitId> <plan>", or "kh <trigger|status|workflows|integrations>"`,
  };
}
