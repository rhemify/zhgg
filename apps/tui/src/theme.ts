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
  green:  fg(0,   255, 136),
  dgreen: fg(0,   140, 75),
  dgreenb:fg(0,   60,  35),
  gray:   fg(55,  60,  65),
  dgray:  fg(28,  32,  36),
  white:  fg(195, 200, 210),
  dwhite: fg(90,  95,  108),
  yellow: fg(255, 210, 55),
  red:    fg(255, 80,  80),
  dred:   fg(120, 40,  40),
  indigo: fg(140, 130, 255),
  amber:  fg(245, 158, 11),
  bgDark: bg(4,   6,   8),
  bgNode: bg(0,   22,  14),
  bgRej:  bg(30,  8,   8),
};
