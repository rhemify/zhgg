// ── Layout constants ─────────────────────────────────────────────────────────
//
// All row/column accessors and panel zone constants live here. They're
// dynamic (depend on the live terminal size at call time), so each is a
// thunk — call them where you need the current row, never cache the
// result across a resize.

export const W = (): number => process.stdout.columns || 120;
export const H = (): number => process.stdout.rows    || 40;
export const MID = (): number => Math.floor(W() * 0.42);

// Fixed row zones (1-indexed)
export const ROW_HEADER_TOP = 1;
export const ROW_HEADER_BOT = 3;
export const ROW_TOP_START  = 4;
export const ROW_TOP_END   = (): number => Math.min(11, Math.floor(H() * 0.30));
export const ROW_MID_DIV   = (): number => ROW_TOP_END() + 1;
export const ROW_BOT_START = (): number => ROW_MID_DIV() + 1;
// Reserve five rows at the bottom for: log border, receipt-status,
// persistent hint, intent input, status, footer-border. The receipt
// JSON itself goes into the RECEIPT side of the bottom-right panel
// (replacing the bare payment-flow strip's old extra padding).
//
// `ROW_HINT` is a single-line "?: help" reminder that floats just
// above the intent input — added in slice D so an operator never has
// to wonder which commands are accepted. The overlay (toggled by `?`)
// renders centred over the FLOW panel, not in this row.
export const ROW_LOG     = (): number => H() - 5;
export const ROW_RECEIPT = (): number => H() - 4;
export const ROW_HINT    = (): number => H() - 3;
export const ROW_INTENT  = (): number => H() - 2;
export const ROW_STATUS  = (): number => H() - 1;
export const ROW_FOOTER  = (): number => H();

// Payment flow node positions (right panel, row-relative to ROW_BOT_START)
export const FLOW_COL    = (): number => MID() + 4;
export const FLOW_NODE_W = 14;
export const FLOW_NODE_H = 3;
export const FLOW_WIRE_H = 1;
export const FLOW_STEP   = FLOW_NODE_H + FLOW_WIRE_H; // 4 rows per node+wire

// Node absolute rows
export const nodeRow = (n: number): number => ROW_BOT_START() + 1 + n * FLOW_STEP;
