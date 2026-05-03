import type { IntentCommand } from '../types.js';
import { PARK_SYMBOLS, type ParkSymbol } from '../types.js';

// ── Yield-vault intents (Slice K — ERC-4626) ─────────────────────────
// Two accepted forms — short (defaults tokenId=1) and explicit:
//   `park <amount> <USDC|WETH>`               e.g. `park 1 USDC`
//   `park <tokenId> <amount> <USDC|WETH>`     e.g. `park 1 0.5 USDC`
// Same shapes for `unpark`. Disambiguation: the short form has 2
// args after the verb; the explicit form has 3. We refuse anything
// else with a precise hint rather than guessing.
export function parsePark(head: string, parts: string[], trimmed: string): IntentCommand {
  const tokens = parts.slice(1);
  let tokenId: bigint;
  let amount: string;
  let symRaw: string;

  if (tokens.length === 2) {
    tokenId = 1n; // default to seed agent
    amount = tokens[0]!;
    symRaw = tokens[1]!;
  } else if (tokens.length === 3) {
    const tidRaw = tokens[0]!;
    if (!/^\d+$/.test(tidRaw)) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: `${head} tokenId "${tidRaw}" — expected positive integer (e.g. 1, 2, 3)`,
      };
    }
    tokenId = BigInt(tidRaw);
    amount = tokens[1]!;
    symRaw = tokens[2]!;
  } else {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: `${head} needs <amount> <USDC|WETH> or <tokenId> <amount> <USDC|WETH> (e.g. "${head} 1 USDC", "${head} 2 0.5 USDC")`,
    };
  }

  if (!/^\d+(\.\d+)?$/.test(amount)) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: `${head} amount "${amount}" — expected decimal (e.g. 1, 0.5)`,
    };
  }
  const symbol = symRaw.toUpperCase();
  if (!PARK_SYMBOLS.has(symbol as ParkSymbol)) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: `${head} symbol "${symRaw}" — supported: USDC, WETH (native ETH not allowed; vault expects ERC-20)`,
    };
  }
  return {
    kind: head === 'park' ? 'park' : 'unpark',
    amount,
    symbol: symbol as ParkSymbol,
    tokenId,
  };
}
