import type { IntentCommand } from '../types.js';
import { MINT_ROLES, type MintRole } from '../types.js';

export function parseMint(parts: string[], trimmed: string): IntentCommand {
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
