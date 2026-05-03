import type { IntentCommand } from '../types.js';
import { resolveTarget } from '../resolve.js';

// ── AxiomCommit intents (Slice H) ────────────────────────────────────
// `commit <tokenId|ens> <plan-text>` → commitPlan(tokenId, keccak256(plan))
// `reveal <commitId>     <plan-text>` → revealPlan(tokenId, commitId, plan, "")
// Plan is rest-of-line, kept verbatim — joining with single spaces is
// intentional (canonicalises whitespace). For reveal, the tokenId is
// recovered from the commit on-chain; the dispatcher reads it via
// commitOf(commitId) before sending the reveal tx.
export function parseAxiomCommit(parts: string[], trimmed: string): IntentCommand {
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

export function parseAxiomReveal(parts: string[], trimmed: string): IntentCommand {
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
