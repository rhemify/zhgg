import type { IntentCommand } from '../types.js';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/;
const ZERO_SALT = `0x${'0'.repeat(64)}` as const;

/// `aa <owner> [salt]` — predict + deploy ERC-4337 SimpleAccount via
/// AgentSimpleAccountFactory. The dispatcher reads
/// AGENT_AA_FACTORY_ADDRESS at dispatch time. Owner case is preserved so
/// the operator's literal echoes back; salt defaults to `bytes32(0)`.
export function parseAa(parts: string[], trimmed: string): IntentCommand {
  if (parts.length < 2) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: 'aa needs an owner: aa <0x-owner> [<0x-bytes32-salt>]',
    };
  }
  const owner = parts[1] ?? '';
  if (!ADDRESS_RE.test(owner)) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: `aa owner "${owner}" is not a 0x-address — expected 0x + 40 hex`,
    };
  }
  if (parts.length === 2) {
    return { kind: 'aa-deploy', owner: owner as `0x${string}`, salt: ZERO_SALT };
  }
  if (parts.length > 3) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: 'aa takes at most two args: <owner> [salt]',
    };
  }
  const salt = parts[2] ?? '';
  if (!BYTES32_RE.test(salt)) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: `aa salt "${salt}" must be 0x + 64 hex (bytes32)`,
    };
  }
  return {
    kind: 'aa-deploy',
    owner: owner as `0x${string}`,
    salt: salt as `0x${string}`,
  };
}
