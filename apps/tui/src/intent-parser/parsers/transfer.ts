import type { IntentCommand } from '../types.js';
import { SWAP_SYMBOLS, type SwapSymbol } from '../types.js';

export function parseTransfer(parts: string[], trimmed: string): IntentCommand {
  // Form: `transfer <amount> <symbol> [to] <recipient>`
  // Filler tokens like `to` / `into` / `→` are stripped so users can
  // type the natural-language version. We also accept `send` and
  // `pay` as aliases — same semantics, different vocabulary.
  const FILLERS = new Set(['to', 'into', '->', '→']);
  const tokens = parts.slice(1).filter((t) => !FILLERS.has(t.toLowerCase()));
  if (tokens.length !== 3) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: 'transfer needs <amount> <symbol> <recipient> (e.g. "transfer 1 USDC vitalik.eth" or "transfer 0.001 ETH to 0xAbc…")',
    };
  }
  const amount = tokens[0]!;
  const symRaw = tokens[1]!;
  const recipient = tokens[2]!;

  if (!/^\d+(\.\d+)?$/.test(amount)) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: `transfer amount "${amount}" — expected decimal (e.g. 0.001, 5)`,
    };
  }
  const symbol = symRaw.toUpperCase();
  if (!SWAP_SYMBOLS.has(symbol as SwapSymbol)) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: `transfer symbol "${symRaw}" — supported: ETH, WETH, USDC`,
    };
  }
  // Cheap recipient sanity-check: 0x40-hex OR *.eth shape. Real
  // validation/resolution happens inside the agent (viem getAddress +
  // ENS lookup) — here we just reject obvious typos so the user gets
  // immediate feedback before the dispatch round-trip.
  const isAddrShape = /^0x[a-fA-F0-9]{40}$/.test(recipient);
  const isEnsShape = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+\.eth$/i.test(recipient) ||
                     /^[a-z0-9_-]+\.eth$/i.test(recipient);
  if (!isAddrShape && !isEnsShape) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: `transfer recipient "${recipient}" — expected 0x-address or *.eth name`,
    };
  }
  return {
    kind: 'transfer',
    amount,
    symbol: symbol as SwapSymbol,
    recipient,
  };
}
