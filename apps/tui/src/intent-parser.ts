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
import { resolveAgent } from './agent-registry.js';

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
