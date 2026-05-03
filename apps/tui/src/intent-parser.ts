/// Barrel re-export — the parser logic lives in `intent-parser/` as a
/// folder of focused files (one per intent arm). This file preserves
/// the existing `from './intent-parser.js'` import path used across the
/// TUI codebase.

export { parseIntent } from './intent-parser/index.js';
export type {
  IntentCommand,
  SwapSymbol,
  ParkSymbol,
  MintRole,
} from './intent-parser/index.js';
