import type { IntentCommand } from '../types.js';
import { resolveTarget } from '../resolve.js';

export function parseAudit(parts: string[], trimmed: string): IntentCommand {
  const target = parts[1]?.trim();
  if (!target) {
    return { kind: 'unknown', raw: trimmed, reason: 'audit needs a target (ens or tokenId)' };
  }
  const resolved = resolveTarget(target, trimmed);
  if (!resolved.ok) return resolved.cmd;
  return { kind: 'audit', target, tokenId: resolved.tokenId };
}
