import type { IntentCommand } from '../types.js';
import { SWAP_SYMBOLS, type SwapSymbol } from '../types.js';

export function parseSwap(parts: string[], trimmed: string): IntentCommand {
  // Accept compact OR natural-language forms:
  //   `swap 0.001 ETH USDC`        ← compact
  //   `swap 0.001 ETH to USDC`     ← natural
  //   `swap 0.001 ETH for USDC`    ← natural
  //   `swap 0.001 ETH -> USDC`     ← arrow
  // Filler tokens are stripped before extracting <amount> <from> <to>.
  const FILLERS = new Set(['from', 'to', 'for', 'into', '->', '→']);
  const tokens = parts.slice(1).filter((t) => !FILLERS.has(t.toLowerCase()));
  if (tokens.length !== 3) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: 'swap needs <amount> <fromSym> <toSym> (e.g. "swap 0.001 ETH USDC" or "swap 0.001 ETH to USDC")',
    };
  }
  const amount = tokens[0]!;
  const fromRaw = tokens[1]!;
  const toRaw = tokens[2]!;

  // ENS-shaped string in a symbol slot is a clear sign the user wanted
  // a transfer (send tokens to an address), not a swap (exchange one
  // token for another). Surface that distinction explicitly.
  if (/\.eth$/i.test(fromRaw) || /\.eth$/i.test(toRaw)) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: 'swap exchanges TOKENS not addresses. ENS in symbol slot suggests you wanted to TRANSFER funds to that address — that intent is not wired yet. For a swap, use ETH/WETH/USDC.',
    };
  }

  if (!/^\d+(\.\d+)?$/.test(amount)) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: `swap amount "${amount}" — expected decimal (e.g. 0.001, 5)`,
    };
  }
  const fromSym = fromRaw.toUpperCase();
  const toSym = toRaw.toUpperCase();
  if (!SWAP_SYMBOLS.has(fromSym as SwapSymbol)) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: `swap fromSym "${fromRaw}" — supported: ETH, WETH, USDC`,
    };
  }
  if (!SWAP_SYMBOLS.has(toSym as SwapSymbol)) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: `swap toSym "${toRaw}" — supported: ETH, WETH, USDC`,
    };
  }
  if (fromSym === toSym) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: `swap fromSym and toSym are identical (${fromSym})`,
    };
  }
  return {
    kind: 'swap',
    amount,
    fromSym: fromSym as SwapSymbol,
    toSym: toSym as SwapSymbol,
  };
}
