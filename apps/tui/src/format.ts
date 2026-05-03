// ── String formatting helpers ────────────────────────────────────────────────
//
// Tiny pure formatters used throughout the frame builder. Kept module-
// level so dispatchers (which also push staged-intent labels into the
// audit trail) can reuse the same shortener without importing render.

import type { IntentCommand } from './intent-parser.js';

export function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

export function shortHash(h: string): string {
  return h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h;
}

export function formatStaged(intent: IntentCommand): string {
  switch (intent.kind) {
    case 'audit': return `audit ${intent.target} (#${intent.tokenId}) topic=${intent.topic}`;
    case 'ask-oracle': return `ask oracle ${intent.raw} (topic=${intent.topic})`;
    case 'swap': return `swap ${intent.amount} ${intent.fromSym} → ${intent.toSym}`;
    case 'transfer': return `transfer ${intent.amount} ${intent.symbol} → ${intent.recipient}`;
    case 'kh-trigger': return `kh trigger ${intent.workflowId}${intent.inputs ? ' (+inputs)' : ''}`;
    case 'kh-status': return `kh status ${intent.executionId}`;
    case 'kh-workflows': return `kh workflows`;
    case 'kh-integrations': return `kh integrations`;
    case 'kh-discover': return `kh discover${intent.search ? ` "${intent.search}"` : ''}`;
    case 'kh-inspect': return `kh inspect ${intent.workflowId}`;
    case 'kh-hire': return `kh hire ${intent.slugOrId}${intent.inputs ? ' (+inputs)' : ''}`;
    case 'axiom-commit': return `commit ${intent.target} (#${intent.tokenId}) plan=${intent.plan.slice(0, 24)}${intent.plan.length > 24 ? '…' : ''}`;
    case 'axiom-reveal': return `reveal ${shortHash(intent.commitId)} plan=${intent.plan.slice(0, 24)}${intent.plan.length > 24 ? '…' : ''}`;
    case 'acp-create': return `acp create ${intent.target} (#${intent.tokenId}) ${intent.usdcAmount} USDC`;
    case 'acp-release': return `acp release jobId=${intent.jobId}`;
    case 'park': return `park ${intent.amount} ${intent.symbol} (#${intent.tokenId} receiver)`;
    case 'unpark': return `unpark ${intent.amount} ${intent.symbol} (#${intent.tokenId} receiver)`;
    case 'delegate': return `delegate → ${intent.to} permId=${shortHash(intent.permissionId)}`;
    default: return '—';
  }
}
