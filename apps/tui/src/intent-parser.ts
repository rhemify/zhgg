/// Tiny shell-style parser for the TUI's intent input.
///
/// Recognised forms:
///   `audit <ens-or-tokenid>`     → kick the cross-agent orchestrator
///   `ask oracle <topic>`         → standalone oracle query
///
/// Anything else returns `{ kind: 'unknown' }` so the caller can render
/// a hint instead of dispatching. We deliberately avoid throwing on bad
/// input — the TUI keeps editing on, the user just sees the
/// "unrecognised" toast and fixes the line.

import type { OracleTopic } from '@zhgg/oracle-data';

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
  | { kind: 'empty' }
  | { kind: 'unknown'; raw: string; reason: string };

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

/// Stable tokenId fallback for ENS-targets — the real cross-agent
/// orchestrator wants a `bigint agentId`, but the TUI doesn't carry
/// an on-chain ENS→tokenId resolver. We hash the ENS string to a
/// 64-bit slot so each typed name maps to a deterministic synthetic
/// id; numeric inputs pass through unchanged.
function targetToTokenId(raw: string): bigint {
  if (/^\d+$/.test(raw)) return BigInt(raw);
  let h = 0n;
  for (let i = 0; i < raw.length; i++) {
    h = (h * 131n + BigInt(raw.charCodeAt(i))) & 0xffffffffffffffffn;
  }
  // Reserve 0 as "unset" so the orchestrator never sees agentId=0.
  return h === 0n ? 1n : h;
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
    return { kind: 'audit', target, tokenId: targetToTokenId(target) };
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
    reason: `unknown intent — try "audit <ens>" or "ask oracle <topic>"`,
  };
}
