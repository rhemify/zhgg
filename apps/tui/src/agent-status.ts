// ── Live-derived AGENTS panel rows ───────────────────────────────────────────
//
// The AGENTS panel reads from `agent-registry.ts` (the on-chain iNFTs we
// minted on 0G Galileo) and reflects the current `runningCommand` state.
// No more hardcoded ACTIVE/WATCHING/PENDING — status is what's actually
// happening RIGHT NOW. The QUEUE panel only shows an entry when an
// intent is staged (typed but not yet dispatched). When idle, both
// panels show their empty state — never lie about activity that didn't
// happen.

import { AGENT_REGISTRY } from './agent-registry.js';
import { $ } from './theme.js';
import type { IntentCommand } from './intent-parser.js';

export interface AgentRow {
  name: string;
  tokenId: bigint;
  scope: string;
}

/// Compose the agent list from the registry. Scope strings mirror the
/// per-tier capability manifests committed in apps/mint-agent/src/index.ts —
/// they describe the iNFT's on-chain capability bytes, not aspirations.
export function liveAgents(): AgentRow[] {
  const scopeFor = (name: string): string => {
    if (name.startsWith('audit'))  return 'EU AI Act auditor · TEE probes on 0G';
    if (name.startsWith('oracle')) return 'Pyth price · regulatory feed';
    if (name.startsWith('swap'))   return 'Uniswap v3 · WETH9 on Base';
    return '?';
  };
  return Object.entries(AGENT_REGISTRY).map(([role, tokenId]) => ({
    name: role + '-agent',
    tokenId,
    scope: scopeFor(role),
  }));
}

export type RunningCommand =
  | 'idle'
  | 'audit'
  | 'ask-oracle'
  | 'swap'
  | 'transfer'
  | 'kh'
  | 'agents'
  | 'balances'
  | 'block'
  | 'mint'
  | 'axiom-commit'
  | 'axiom-reveal'
  | 'park'
  | 'unpark'
  | 'delegate';

/// Map runningCommand + stagedIntent to a per-agent status label that
/// explains each agent's ROLE in the current cross-agent workflow, not
/// just whether it's active.
///
/// During `audit <tokenId>`:
///   - The target token → SUBJECT (being evaluated by the auditor)
///   - oracle-agent (#2) → CONSULTED (oracle query is always part of audit)
///   - other agents → idle
///
/// During `ask oracle`:
///   - oracle-agent (#2) → QUERIED
///
/// During `swap`:
///   - swap-agent (#3) → EXECUTING
export function agentStatus(
  row: AgentRow,
  stagedIntent: IntentCommand | null,
  runningCommand: RunningCommand,
): { label: string; color: string; glyph: string } {
  const auditTokenId = stagedIntent?.kind === 'audit' ? stagedIntent.tokenId : null;

  if (runningCommand === 'audit') {
    if (row.tokenId === auditTokenId) return { label: 'SUBJECT  ←', color: $.bold + $.green, glyph: '●' };
    if (row.tokenId === 2n)          return { label: 'CONSULTED ↗', color: $.green, glyph: '◎' };
    return { label: 'idle', color: $.dwhite, glyph: '○' };
  }
  if (runningCommand === 'ask-oracle') {
    if (row.tokenId === 2n) return { label: 'QUERIED  ←', color: $.bold + $.green, glyph: '●' };
    return { label: 'idle', color: $.dwhite, glyph: '○' };
  }
  if (runningCommand === 'swap') {
    if (row.tokenId === 3n) return { label: 'EXECUTING ←', color: $.bold + $.green, glyph: '●' };
    return { label: 'idle', color: $.dwhite, glyph: '○' };
  }

  // Staged (typed but not dispatched yet)
  if (stagedIntent) {
    if (stagedIntent.kind === 'audit' && row.tokenId === auditTokenId)
      return { label: 'STAGED   →', color: $.yellow, glyph: '◎' };
    if (stagedIntent.kind === 'ask-oracle' && row.tokenId === 2n)
      return { label: 'STAGED   →', color: $.yellow, glyph: '◎' };
    if (stagedIntent.kind === 'swap' && row.tokenId === 3n)
      return { label: 'STAGED   →', color: $.yellow, glyph: '◎' };
  }

  return { label: 'idle', color: $.dwhite, glyph: '○' };
}
