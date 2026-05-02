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
  lines.push('  commit <tokenId|ens> <plan>     AxiomCommit.commitPlan (0G)');
  lines.push('     e.g.  commit 1 buy 0.05 ETH if EU AI Act compliant');
  lines.push('           commit audit.zhgg.eth refuse cap_exceeded');
  lines.push('  reveal <commitId> <plan>        AxiomCommit.revealPlan (0G)');
  lines.push('     e.g.  reveal 0xabc…def buy 0.05 ETH if EU AI Act compliant');
  lines.push('     plan must match committed text byte-for-byte');
  lines.push('     requires AXIOM_COMMIT_ADDRESS + MINT_AGENT_PRIVATE_KEY');
  lines.push('');
  lines.push('  delegate <to> <permissionId>    ERC-7710 redeemable delegation');
  lines.push('     e.g.  delegate oracle.zhgg.eth 0x0000…0001');
  lines.push('           delegate 0xAbc…123 0xa1b2…f00d');
  lines.push('     <to> = 0x-addr | *.zhgg.eth | mainnet *.eth');
  lines.push('     posts to DelegationManager (Base Sepolia); SpendCap auto-debits');
  lines.push('     requires DELEGATION_MANAGER_ADDRESS + SPEND_CAP_ADDRESS');
  lines.push('');
  lines.push('  acp create <agentTokenId|ens> <usdcAmount>   open + fund job (EIP-8183)');
  lines.push('     e.g.  acp create oracle.zhgg.eth 0.5');
  lines.push('           acp create 2 10                (10 USDC escrow → token #2 owner)');
  lines.push('  acp release <jobId>            evaluator releases escrow → provider');
  lines.push('     e.g.  acp release 1');
  lines.push('     calls AgenticCommerce.complete (0G); only the job evaluator may');
  lines.push('     requires ACP_ADDRESS + AGENT_NFT_ADDRESS + ACP_PAYMENT_TOKEN');
  lines.push('');
  lines.push('  park <amount> <USDC|WETH>     deposit receiver idle into MockERC4626');
  lines.push('     e.g.  park 1 USDC                  (defaults to iNFT #1)');
  lines.push('           park 2 0.5 USDC              (explicit tokenId)');
  lines.push('     requires: receiver wallet funded with the asset');
  lines.push('               YIELD_VAULT_ADDRESS in env (deploy via forge script)');
  lines.push('  unpark <amount> <USDC|WETH>   redeem from vault back to receiver');
  lines.push('     e.g.  unpark 0.5 USDC             (owner-only — must own iNFT)');
  lines.push('');
  // ── Operator UX (Phase 3) ─────────────────────────────────────────────
  // Read-only inspections plus the one explicitly-confirmed write
  // (`mint`). They bypass the FLOW panel because they don't exercise
  // the audit/payment pipeline.
  lines.push('  agents                  list our iNFTs (ownerOf, capabilities)');
  lines.push('  balances                wallet: 0G + ETH/USDC/WETH on Base');
  lines.push('  block                   current block heights (0G + Base)');
  lines.push('  cancel                  abort the in-flight dispatch');
  lines.push('  mint <role>             mint a new iNFT (audit|oracle|swap)');
  lines.push('');
  lines.push('  kh discover [search]         browse public KH marketplace (≈85 wfs)');
  lines.push('  kh inspect <wfId>            full inputSchema + price for one workflow');
  lines.push('  kh hire <slug|id> [<json>]   pay (x402, USDC on Base) + invoke MCP wf');
  lines.push('  kh workflows                 list workflows visible to your org');
  lines.push('  kh integrations              list connected integrations (web3, etc)');
  lines.push('  kh trigger <wfId> [<json>]   fire saved KeeperHub workflow');
  lines.push('  kh status <executionId>      poll workflow run state');
  lines.push('     e.g.  kh discover aave           → 6 Aave-related workflows');
  lines.push('           kh inspect zaajy1vtnd…     → schema + price metadata');
  lines.push('           kh hire mcp-test {"address":"0xAbc…"}   → x402 settle + run');
  lines.push('           kh trigger wf-42 {"x":1}');
  lines.push('     requires KH_API_KEY (kh_…); KEEPERHUB_API_URL optional');
  lines.push('     `kh hire` also requires KH_AUTHOR_{SUBORG_ID,WALLET,HMAC_SECRET}');
  lines.push('     (Turnkey-custodied buyer wallet; provision via @keeperhub/wallet)');
  lines.push('');
  for (const ln of buildAgentLines()) lines.push(ln);
  lines.push('');
  lines.push('  keys:  [G] grant SpendCap (required before first audit)');
  lines.push('         [Enter] dispatch  [Esc] clear/cancel  [TAB] focus  [Q] quit');
  return lines;
}

/// Persistent one-line hint that lives just above the intent input
/// row. Shorter than the overlay — designed to remind a confused
/// operator that `?` exists without taking screen real estate.
export const PERSISTENT_HINT = '?: help  │  first time? press [G] to grant SpendCap, then audit/ask/swap';
