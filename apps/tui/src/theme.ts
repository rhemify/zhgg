// ── ANSI primitives + colour palette ─────────────────────────────────────────
//
// Pure ANSI escape sequences and the colour palette used across the
// frame builder. Kept in its own module so other render helpers can
// pull just the palette without importing the rest of the TUI.

export const E = '\x1b';
export const at = (r: number, c: number): string => `${E}[${r};${c}H`;
export const fg = (r: number, g: number, b: number): string => `${E}[38;2;${r};${g};${b}m`;
export const bg = (r: number, g: number, b: number): string => `${E}[48;2;${r};${g};${b}m`;

export const $ = {
  reset:  `${E}[0m`,
  bold:   `${E}[1m`,
  dim:    `${E}[2m`,
  // structural border accent — teal/cyan (green reserved for success states)
  cyan:   fg(0,   200, 220),
  dcyan:  fg(0,   130, 150),
  // success / active states
  green:  fg(0,   255, 136),
  dgreen: fg(0,   140, 75),
  dgreenb:fg(0,   60,  35),
  // text hierarchy — all bumped up for readability
  white:  fg(220, 228, 240),   // primary content (was 195,200,210)
  dwhite: fg(148, 158, 175),   // dimmed labels (was 90,95,108 — nearly invisible)
  gray:   fg(90,  100, 115),   // de-emphasised (was 55,60,65)
  dgray:  fg(52,  60,  72),    // structural only (was 28,32,36)
  // status colors
  yellow: fg(255, 210, 55),
  red:    fg(255, 80,  80),
  dred:   fg(120, 40,  40),
  indigo: fg(140, 130, 255),
  amber:  fg(245, 158, 11),
  // backgrounds
  bgDark:   bg(4,   6,   8),
  bgPanel:  bg(8,   14,  22),   // panel header row tint
  bgNode:   bg(0,   22,  14),
  bgRej:    bg(30,  8,   8),
  bgCursor: bg(30,  50,  80),   // audit row highlight
};
