import type { IntentCommand } from '../types.js';
import { resolveTarget } from '../resolve.js';

// ── ACP / EIP-8183 escrow intents (Slice J) ──────────────────────────
// Two sub-verbs against the deployed AgenticCommerce contract on 0G:
//   `acp create <agentTokenId|ens> <usdcAmount>` → createJob+fund
//   `acp release <jobId>`                         → complete (releases
//                                                    escrow → provider)
//
// agentTokenId follows the same digits-or-ENS resolution as `audit`.
// usdcAmount is a decimal-string in the payment token's units (the
// dispatcher applies parseUnits(_, 6) and reads the actual token
// address from ACP_PAYMENT_TOKEN env). jobId is bare uint256 digits.
//
// Refusals are surfaced as `unknown` with a precise reason — the
// dispatcher only ever sees a well-formed `acp-create` / `acp-release`.
export function parseAcp(parts: string[], trimmed: string): IntentCommand {
  const sub = parts[1]?.toLowerCase();
  if (!sub) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: 'acp needs a sub-verb: create | release',
    };
  }
  if (sub === 'create') {
    const target = parts[2]?.trim();
    const amount = parts[3]?.trim();
    if (!target || !amount) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: 'acp create needs <agentTokenId> <usdcAmount> (e.g. "acp create 2 0.5")',
      };
    }
    if (parts.length > 4) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: 'acp create takes exactly two arguments: <agentTokenId|ens> <usdcAmount>',
      };
    }
    // Decimal shape — same regex as swap/transfer so the dispatcher's
    // parseUnits(_, 6) call never throws on user-typed input.
    if (!/^\d+(\.\d+)?$/.test(amount)) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: `acp create amount "${amount}" — expected decimal USDC (e.g. 0.5, 10, 100.25)`,
      };
    }
    // Reject zero-budget early — the contract reverts with ZeroBudget()
    // on fund(); we can save the round trip and surface a clearer hint.
    if (/^0(\.0+)?$/.test(amount)) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: 'acp create amount "0" — escrow must be > 0 (contract reverts ZeroBudget)',
      };
    }
    const resolved = resolveTarget(target, trimmed);
    if (!resolved.ok) return resolved.cmd;
    return { kind: 'acp-create', target, tokenId: resolved.tokenId, usdcAmount: amount };
  }
  if (sub === 'release') {
    const jobIdRaw = parts[2]?.trim();
    if (!jobIdRaw) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: 'acp release needs <jobId> (e.g. "acp release 1")',
      };
    }
    if (parts.length > 3) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: 'acp release takes exactly one argument: <jobId>',
      };
    }
    // Plain uint256 digits only — leading zeros, signs, and hex are
    // all rejected. Real jobIds are monotonic from 1.
    if (!/^[0-9]+$/.test(jobIdRaw)) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: `acp release jobId "${jobIdRaw}" — expected uint256 digits (e.g. 1, 42)`,
      };
    }
    const jobId = BigInt(jobIdRaw);
    if (jobId === 0n) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: 'acp release jobId "0" — jobIds start at 1',
      };
    }
    return { kind: 'acp-release', jobId };
  }
  return {
    kind: 'unknown',
    raw: trimmed,
    reason: `acp: unknown sub-verb "${sub}" — supported: create, release`,
  };
}
