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
    if (name.startsWith('audit'))  return '[probe,tee_attestation]';
    if (name.startsWith('oracle')) return '[pyth,eu-ai-act,usdc]';
    if (name.startsWith('swap'))   return '[uniswap-v3,weth9]';
    return '[?]';
  };
  return Object.entries(AGENT_REGISTRY).map(([ens, tokenId]) => ({
    name: ens.replace(/\.zhgg\.eth$/, '-agent'),
    tokenId,
    scope: scopeFor(ens),
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
  | 'acp-create'
  | 'acp-release'
  | 'park'
  | 'unpark'
  | 'delegate';

/// Map runningCommand + stagedIntent to a per-agent status. Three states:
///   running  → that agent is actively dispatching (green ●)
///   staged   → an intent for this agent is staged but not dispatched
///              (yellow ◎)
///   idle     → no activity (dim ○)
export function agentStatus(
  row: AgentRow,
  stagedIntent: IntentCommand | null,
  runningCommand: RunningCommand,
): { label: string; color: string; glyph: string } {
  const stagedKind = stagedIntent?.kind;
  const stagedTokenForAudit = stagedIntent?.kind === 'audit' ? stagedIntent.tokenId : null;
  const matchesStaged =
    (stagedKind === 'audit' && stagedTokenForAudit === row.tokenId) ||
    (stagedKind === 'ask-oracle' && row.tokenId === 2n) ||
    (stagedKind === 'swap' && row.tokenId === 3n);
  const matchesRunning =
    (runningCommand === 'audit' && row.tokenId === 1n) ||
    (runningCommand === 'ask-oracle' && row.tokenId === 2n) ||
    (runningCommand === 'swap' && row.tokenId === 3n);
  if (matchesRunning) return { label: 'RUNNING', color: $.green, glyph: '●' };
  if (matchesStaged)  return { label: 'STAGED',  color: $.yellow, glyph: '◎' };
  return { label: 'IDLE', color: $.dwhite, glyph: '○' };
}
