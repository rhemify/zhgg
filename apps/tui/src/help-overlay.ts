/// Static text content for the `?` help overlay.
///
/// The overlay is purely informational — a 12-row floating box that
/// describes every command the intent parser accepts plus the global
/// hotkeys. We pull the agent list dynamically from `agent-registry.ts`
/// so newly minted iNFTs appear without touching this file.
///
/// Render shape: an array of plain strings (the renderer in `index.ts`
/// wraps each line in border glyphs and ANSI styles). Keep individual
/// lines ≤ 72 chars so the box fits inside a 78-col modal even with
/// the `║ … ║` borders.

import { AGENT_REGISTRY } from './agent-registry.js';

/// Build the agent-list lines from the registry. Wraps onto a second
/// line when the joined list exceeds the modal interior width so the
/// overlay degrades gracefully as we mint more iNFTs.
function buildAgentLines(): string[] {
  const entries = Object.entries(AGENT_REGISTRY).map(([name, id]) => `${name}(#${id})`);
  if (entries.length === 0) return ['  registered agents:  (none — mint via bun mint-agent)'];

  const head = '  registered agents:  ';
  const indent = ' '.repeat(head.length);
  const maxWidth = 64; // overlay interior width budget for one line

  const lines: string[] = [];
  let current = head;
  for (const entry of entries) {
    const candidate = current === head ? current + entry : `${current}  ${entry}`;
    if (candidate.length > maxWidth && current !== head) {
      lines.push(current);
      current = indent + entry;
    } else {
      current = candidate;
    }
  }
  lines.push(current);
  return lines;
}

/// Returns the full overlay body as plain strings (no borders, no ANSI).
/// Caller is responsible for box-drawing and styling.
export function buildHelpLines(): string[] {
  const lines: string[] = [];
  lines.push('  audit <tokenId|ens>     run cross-agent audit');
  lines.push('     e.g.  audit 1');
  lines.push('           audit oracle.zhgg.eth   (resolves to token #2)');
  lines.push('');
  lines.push('  ask oracle <topic>      direct oracle query');
  lines.push('     e.g.  ask oracle eu-ai-act');
  lines.push('           ask oracle ETH/USD');
  lines.push('');
  lines.push('  swap <amount> <from> <to>  agent-executed token swap');
  lines.push('     e.g.  swap 0.001 ETH USDC      (compact)');
  lines.push('           swap 0.001 ETH to USDC   (natural)');
  lines.push('           supported: ETH, WETH, USDC');
  lines.push('');
  lines.push('  transfer <amount> <token> to <recipient>   send to address/ENS');
  lines.push('     e.g.  transfer 1 USDC vitalik.eth');
  lines.push('           transfer 0.001 ETH to 0xAbc…123');
  lines.push('     aliases: send, pay');
  lines.push('');
  for (const ln of buildAgentLines()) lines.push(ln);
  lines.push('');
  lines.push('  keys:  [G] grant SpendCap (required before first audit)');
  lines.push('         [Enter] dispatch  [Esc] clear  [TAB] focus  [Q] quit');
  return lines;
}

/// Persistent one-line hint that lives just above the intent input
/// row. Shorter than the overlay — designed to remind a confused
/// operator that `?` exists without taking screen real estate.
export const PERSISTENT_HINT = '?: help  │  first time? press [G] to grant SpendCap, then audit/ask/swap';
