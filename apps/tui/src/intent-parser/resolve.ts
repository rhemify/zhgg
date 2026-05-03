/// Shared resolver helpers used by multiple parser arms — oracle topic
/// canonicalisation and `audit`-style target → tokenId resolution.

import type { OracleTopic } from '@zhgg/oracle-data';
import { resolveAgent } from '../agent-registry.js';
import type { IntentCommand } from './types.js';

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
export function resolveOracleTopic(raw: string): OracleTopic | null {
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
export type TargetResolution =
  | { ok: true; tokenId: bigint }
  | { ok: false; cmd: IntentCommand };

export function resolveTarget(target: string, raw: string): TargetResolution {
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
