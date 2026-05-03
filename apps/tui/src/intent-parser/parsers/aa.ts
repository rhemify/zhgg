import type { IntentCommand } from '../types.js';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/;
const HEX_BLOB_RE = /^0x([a-fA-F0-9]{2})*$/;
const DECIMAL_RE = /^\d+(\.\d+)?$/;
const ZERO_SALT = `0x${'0'.repeat(64)}` as const;

/// Two `aa` shapes:
///   1. `aa <owner> [salt]`             — predict + deploy SimpleAccount
///   2. `aa send <to> <amountEth> [hex]` — build + sign + send a UserOp
///
/// Form (1) hits AgentSimpleAccountFactory.createAccount; form (2) hits
/// the canonical EntryPoint v0.7 via Pimlico's bundler. The dispatcher
/// owns env validation in both cases (factory, owner key, bundler URL).
export function parseAa(parts: string[], trimmed: string): IntentCommand {
  if (parts.length < 2) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: 'aa needs an arg: aa <0x-owner> [salt]   OR   aa send <to> <amountEth> [calldata]',
    };
  }

  // Subcommand: `aa send ...`
  if (parts[1]?.toLowerCase() === 'send') {
    return parseAaSend(parts, trimmed);
  }

  // Subcommand: `aa deploy <owner> [salt]` — alias for `aa <owner> [salt]`
  if (parts[1]?.toLowerCase() === 'deploy') {
    return parseAa(['aa', ...parts.slice(2)], trimmed);
  }

  // Default: `aa <owner> [salt]` (deploy)
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

function parseAaSend(parts: string[], trimmed: string): IntentCommand {
  // parts: ['aa', 'send', <to>, <amount>, [calldata]]
  if (parts.length < 3) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: 'aa send needs a recipient (to): aa send <0x-to> <amountEth> [<0x-calldata>]',
    };
  }
  if (parts.length < 4) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: 'aa send needs an amount in ETH: aa send <to> <amountEth> [calldata]',
    };
  }
  if (parts.length > 5) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: 'aa send takes at most three args: <to> <amountEth> [calldata]',
    };
  }
  const to = parts[2] ?? '';
  if (!ADDRESS_RE.test(to)) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: `aa send to "${to}" is not a 0x-address`,
    };
  }
  const amount = parts[3] ?? '';
  if (!DECIMAL_RE.test(amount)) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: `aa send amount "${amount}" must be a decimal number in ETH (e.g. "0.001" or "0")`,
    };
  }
  const callData = parts[4] ?? '0x';
  if (!HEX_BLOB_RE.test(callData)) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: `aa send calldata "${callData}" must be 0x-prefixed even-length hex`,
    };
  }
  return {
    kind: 'aa-send',
    to: to as `0x${string}`,
    amountEth: amount,
    callData: callData as `0x${string}`,
  };
}
