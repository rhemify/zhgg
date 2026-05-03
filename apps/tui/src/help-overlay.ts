/// Contextual full-screen command palette for `?`.
///
/// Reads process.env at call time to show only what is actually wired up.
/// Each command group has an availability check — locked groups are shown
/// dimmed with the specific missing env var so the operator knows exactly
/// what to add, not a generic "unavailable" message.

import { AGENT_REGISTRY } from './agent-registry.js';

export interface HelpLine {
  text: string;
  // 'ok' = available now, 'warn' = partial, 'locked' = missing env, 'info' = header/blank
  kind: 'ok' | 'warn' | 'locked' | 'info';
}

function env(key: string): boolean {
  const v = process.env[key];
  return typeof v === 'string' && v.length > 0;
}

function miss(...keys: string[]): string[] {
  return keys.filter(k => !env(k));
}

export function buildHelpLines(): HelpLine[] {
  const lines: HelpLine[] = [];

  const khKey        = env('KH_API_KEY');
  const khWallet     = env('KH_AUTHOR_SUBORG_ID') && env('KH_AUTHOR_WALLET') && env('KH_AUTHOR_HMAC_SECRET');
  const zgRouter     = env('ZG_ROUTER_KEY');
  const basePk       = env('BASE_SEPOLIA_PRIVATE_KEY');
  const mintPk       = env('MINT_AGENT_PRIVATE_KEY');
  const axiom        = env('AXIOM_COMMIT_ADDRESS') && env('MINT_AGENT_PRIVATE_KEY');
  const delegation   = env('DELEGATION_MANAGER_ADDRESS') && env('SPEND_CAP_ADDRESS');
  const yieldVault   = env('YIELD_VAULT_ADDRESS');

  const agents = Object.entries(AGENT_REGISTRY).map(([n, id]) => `${n} #${id}`).join('  ·  ');

  // ── Always available ──────────────────────────────────────────────────────
  const h = (t: string): HelpLine => ({ text: t, kind: 'info' });
  const ok = (t: string): HelpLine => ({ text: t, kind: 'ok' });
  const locked = (t: string): HelpLine => ({ text: t, kind: 'locked' });
  const warn = (t: string): HelpLine => ({ text: t, kind: 'warn' });

  lines.push(h(''));
  lines.push(h('  ── ALWAYS AVAILABLE ─────────────────────────────────────────────'));
  lines.push(ok ('  agents                      list minted iNFTs + capabilities'));
  lines.push(ok ('  balances                    wallet: 0G OG + ETH / USDC / WETH on Base'));
  lines.push(ok ('  block                       current block height on 0G + Base Sepolia'));
  lines.push(ok ('  cancel                      abort the in-flight dispatch'));
  if (agents) lines.push(h(`  registered:  ${agents}`));

  // ── KeeperHub ─────────────────────────────────────────────────────────────
  lines.push(h(''));
  const khMissing = miss('KH_API_KEY');
  lines.push(h(`  ── KEEPERHUB MARKETPLACE ${khKey ? '✓ API key set' : '✗ needs KH_API_KEY'} ──────────────────────────────`));
  if (khKey) {
    lines.push(ok('  kh discover [search]        browse 30 MCP-callable workflows'));
    lines.push(ok('  kh inspect <id|slug>        full inputSchema + price'));
    lines.push(ok('  kh workflows                workflows visible to your org'));
    lines.push(ok('  kh trigger <wfId> [json]    fire a saved workflow'));
    lines.push(ok('  kh status <execId>          poll run state'));
    if (khWallet) {
      lines.push(ok('  kh hire <slug> [json]       x402 USDC payment → MCP workflow'));
      lines.push(h ('    → run  kh discover  to see callable slugs + required inputs'));
      lines.push(h ('    → run  kh inspect <slug>  to see inputSchema before hiring'));
    } else {
      const mKh = miss('KH_AUTHOR_SUBORG_ID','KH_AUTHOR_WALLET','KH_AUTHOR_HMAC_SECRET');
      lines.push(locked(`  kh hire  ✗  needs: ${mKh.join(', ')}  (run: bunx @keeperhub/wallet add)`));
    }
  } else {
    lines.push(locked('  kh *  ✗  KH_API_KEY missing — paste kh_… key into .env'));
  }

  // ── 0G audit ─────────────────────────────────────────────────────────────
  lines.push(h(''));
  lines.push(h(`  ── AUDIT / 0G COMPUTE ${zgRouter ? '✓' : '✗ needs ZG_ROUTER_KEY'} ─────────────────────────────────────`));
  if (zgRouter) {
    lines.push(ok('  audit <tokenId> [topic]     cross-agent oracle audit (TEE inference on 0G)'));
    lines.push(h ('    topics: eu-ai-act (default) · mica · gdpr-ai · price'));
    lines.push(h ('    e.g.  audit 1   audit 1 mica   audit 2 gdpr-ai   audit 1 price'));
    lines.push(ok('  ask oracle <topic>          live price (Pyth) or regulatory deltas'));
    lines.push(h ('    e.g.  ask oracle ETH/USD   →  ETH/USD = $2,309.63  (Pyth live, 14s ago)'));
    lines.push(h ('           ask oracle eu-ai-act →  Article 6 (eff. 2026-08-02): High-risk AI…'));
  } else {
    lines.push(locked('  audit / ask oracle  ✗  ZG_ROUTER_KEY missing'));
  }

  // ── Base Sepolia trading ──────────────────────────────────────────────────
  lines.push(h(''));
  lines.push(h(`  ── TRADING / BASE SEPOLIA ${basePk ? '✓' : '✗ needs BASE_SEPOLIA_PRIVATE_KEY'} ─────────────────────────────`));
  if (basePk) {
    lines.push(ok('  swap <amt> <from> <to>      Uniswap v3 token swap'));
    lines.push(h ('    e.g.  swap 0.001 ETH USDC'));
    lines.push(ok('  transfer <amt> <token> to <addr>   ERC-20 send'));
    lines.push(h ('    e.g.  transfer 1 USDC 0xAbc…'));
    if (mintPk) {
      lines.push(ok('  mint <role>                 mint a new iNFT (audit|oracle|swap)'));
    } else {
      lines.push(locked('  mint  ✗  needs MINT_AGENT_PRIVATE_KEY'));
    }
  } else {
    lines.push(locked('  swap / transfer  ✗  BASE_SEPOLIA_PRIVATE_KEY missing'));
  }

  // ── Advanced ─────────────────────────────────────────────────────────────
  lines.push(h(''));
  lines.push(h('  ── ADVANCED ──────────────────────────────────────────────────────'));
  if (axiom) {
    lines.push(ok('  commit <tokenId> <plan>     AxiomCommit.commitPlan (0G)'));
    lines.push(ok('  reveal <commitId> <plan>    AxiomCommit.revealPlan (0G)'));
  } else {
    lines.push(locked(`  commit / reveal  ✗  needs: ${miss('AXIOM_COMMIT_ADDRESS','MINT_AGENT_PRIVATE_KEY').join(', ')}`));
  }
  if (delegation) {
    lines.push(ok('  delegate <to> <permId>      ERC-7710 redeemable delegation (Base)'));
  } else {
    lines.push(warn(`  delegate  ~  needs: ${miss('DELEGATION_MANAGER_ADDRESS','SPEND_CAP_ADDRESS').join(', ')}`));
  }
  if (yieldVault) {
    lines.push(ok('  park <amt> <USDC|WETH>      deposit into ERC-4626 yield vault'));
    lines.push(ok('  unpark <amt> <USDC|WETH>    redeem from vault'));
  } else {
    lines.push(warn('  park / unpark  ~  needs YIELD_VAULT_ADDRESS'));
  }

  // ── Keys ─────────────────────────────────────────────────────────────────
  lines.push(h(''));
  lines.push(h('  ── KEYS ──────────────────────────────────────────────────────────'));
  lines.push(ok('  [Enter] dispatch  [Esc] blur/close  [G] grant SpendCap (anytime)  [Q] quit'));
  lines.push(ok('  [Z] audit full-view  [X] receipt full-view  [R] reset  [TAB] focus'));
  lines.push(h(''));

  return lines;
}

/// Persistent one-line hint above the intent input.
export const PERSISTENT_HINT = '[?] commands  │  [G] grant SpendCap (anytime, 0.5 USDC/hr)  │  [Enter] dispatch  │  [Esc] blur';
