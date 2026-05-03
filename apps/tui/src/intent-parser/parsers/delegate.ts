import type { IntentCommand } from '../types.js';

// ── Delegation intent (Slice I — ERC-7710) ───────────────────────────
// `delegate <to> <permissionId>` — issues a real redeemable delegation
// via DelegationManager on Base Sepolia. <to> is one of:
//   - 0x + 40 hex address (validated by viem getAddress in the dispatcher)
//   - agent ENS like `oracle.zhgg.eth` (resolved via agent-registry →
//     AgentNFT.ownerOf on 0G Galileo to recover the iNFT owner address)
//   - mainnet ENS like `vitalik.eth` (resolved via resolveRecipient)
// <permissionId> MUST be 0x + 64 hex bytes32. We validate the shape
// here so the dispatcher never has to invent a hint for a typo'd id;
// a real "permission not granted" path stays available on chain via
// SpendCap's CapNotFound revert during redeem.
export function parseDelegate(parts: string[], trimmed: string): IntentCommand {
  const to = parts[1]?.trim() ?? '';
  const permissionId = parts[2]?.trim() ?? '';
  if (!to) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: 'delegate needs <to> <permissionId> (e.g. "delegate 2 0x0000…0001")',
    };
  }
  if (!permissionId) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: 'delegate needs a permissionId (0x + 64 hex bytes32)',
    };
  }
  if (parts.length > 3) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: 'delegate takes exactly two arguments: <to> <permissionId>',
    };
  }
  // Shape-validate <to>: 0x40-hex OR *.eth name. The dispatcher does
  // the real resolution (checksum + ENS lookup); we just reject obvious
  // typos so the operator gets immediate feedback.
  const isAddrShape = /^0x[a-fA-F0-9]{40}$/.test(to);
  const isEnsShape = /\.eth$/i.test(to);
  if (!isAddrShape && !isEnsShape) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: `delegate to "${to}" — expected 0x-address or *.eth name (mainnet ENS or *.zhgg.eth agent)`,
    };
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(permissionId)) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: `delegate permissionId "${permissionId}" — expected 0x + 64 hex chars (bytes32)`,
    };
  }
  return {
    kind: 'delegate',
    to,
    permissionId: permissionId as `0x${string}`,
  };
}
