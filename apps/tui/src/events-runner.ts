/// Events-driven TUI runner — subscribes a TUI state object to a real
/// `runCrossAgentDemo` EventEmitter and translates `TranscriptStep`
/// emissions into agent-row + split-panel mutations. Pure mapping
/// layer: no I/O, no timers, no rendering. The script-driven runner
/// in `agents-tui.ts` keeps using its hardcoded SCRIPT for recordings;
/// this module is what the live `--tui` flag in apps/demo wires up.
///
/// Decoupled from `@zhgg/workflow` so tui doesn't pull the audit /
/// oracle deps. Callers pass a generic `EventEmitter` whose event
/// names match the orchestrator's `TranscriptStepName` union — the
/// runner is tolerant of unknown names (logs and ignores).

import type { EventEmitter } from 'node:events';
import { pushSplit, type SplitEvent } from './panels/splits.js';
import type { AgentRow, AgentStatus } from './panels/agents.js';

/// Subset of the orchestrator's transcript-step shape — only the
/// fields the TUI cares about. Defined locally to avoid a cross-app
/// import.
interface TranscriptStep {
  tMs: number;
  name: string;
  detail?: Record<string, unknown>;
}

export interface RunnerState {
  agents: Map<string, AgentRow>;
  splits: SplitEvent[];
  startedAt: number;
}

/// Mutate `state.agents` for `ens`, creating the row if absent.
function setAgent(state: RunnerState, ens: string, patch: Partial<AgentRow>): void {
  const existing = state.agents.get(ens) ?? {
    ens,
    role: '?',
    status: 'idle' as AgentStatus,
    lastAction: '',
    ageMs: 0,
  };
  state.agents.set(ens, { ...existing, ...patch });
}

const AUDIT_ENS = 'audit.zhgg.eth';
const ORACLE_ENS = 'oracle.zhgg.eth';

/// Project a single `TranscriptStep` onto the TUI state. Pure — no I/O.
/// Exported so the unit test can fire steps without an EventEmitter.
export function applyStep(state: RunnerState, step: TranscriptStep): void {
  switch (step.name) {
    case 'oracle.spend_cap.check':
      setAgent(state, AUDIT_ENS, {
        role: 'auditor',
        status: 'running',
        lastAction: 'spend-cap pre-flight',
      });
      break;

    case 'oracle.spend_cap.exceeded':
      setAgent(state, AUDIT_ENS, {
        status: 'error',
        lastAction: `spend cap blocked: ${detailString(step.detail, 'reason') ?? '?'}`,
      });
      break;

    case 'oracle.payment.request':
      setAgent(state, AUDIT_ENS, {
        role: 'auditor',
        status: 'running',
        lastAction: 'requesting oracle payment',
      });
      setAgent(state, ORACLE_ENS, {
        role: 'oracle',
        status: 'running',
        lastAction: 'awaiting payment',
      });
      break;

    case 'oracle.payment.settle': {
      const txHash = detailString(step.detail, 'txHash');
      state.splits = pushSplit(state.splits, {
        tMs: step.tMs,
        totalAtomic: '100000',
        asset: 'USDC',
        ownerAddress: '0x000000000000000000000000000000000000beef',
        context: 'audit → oracle',
      });
      setAgent(state, ORACLE_ENS, {
        lastAction: txHash
          ? `payment settled (${shortHash(txHash)})`
          : 'payment settled',
      });
      break;
    }

    case 'oracle.query.start':
      setAgent(state, ORACLE_ENS, {
        lastAction: `querying ${detailString(step.detail, 'topic') ?? 'feed'}`,
      });
      break;

    case 'oracle.query.complete':
      setAgent(state, ORACLE_ENS, {
        status: 'done',
        lastAction: 'oracle response delivered',
      });
      setAgent(state, AUDIT_ENS, { lastAction: 'received oracle response' });
      break;

    case 'audit.capabilities.read':
      setAgent(state, AUDIT_ENS, { lastAction: 'read iNFT capabilities' });
      break;

    case 'audit.axiom.commit':
      setAgent(state, AUDIT_ENS, { lastAction: 'AXIOM plan committed' });
      break;

    case 'audit.start':
      setAgent(state, AUDIT_ENS, {
        status: 'running',
        lastAction: `audit started agentId=${detailString(step.detail, 'agentId') ?? '?'}`,
      });
      break;

    case 'audit.complete': {
      const verdict = detailString(step.detail, 'verdict') ?? '?';
      setAgent(state, AUDIT_ENS, {
        status: verdict === 'compliant' ? 'done' : 'error',
        lastAction: `verdict: ${verdict}`,
      });
      break;
    }

    case 'audit.failed':
      setAgent(state, AUDIT_ENS, {
        status: 'error',
        lastAction: `audit failed: ${detailString(step.detail, 'reason') ?? '?'}`,
      });
      break;

    case 'audit.receipt.post':
      setAgent(state, AUDIT_ENS, { lastAction: 'erc-8004 receipt posted' });
      break;

    case 'audit.receipt.failed':
      setAgent(state, AUDIT_ENS, {
        status: 'error',
        lastAction: `receipt post failed: ${detailString(step.detail, 'reason') ?? '?'}`,
      });
      break;

    case 'audit.memory_root.pin':
      setAgent(state, AUDIT_ENS, { lastAction: 'memoryRoot pinned to iNFT' });
      break;

    case 'audit.axiom.reveal':
      setAgent(state, AUDIT_ENS, { lastAction: 'AXIOM plan revealed' });
      break;

    default:
      // Unknown step — TUI is forward-compatible with new orchestrator
      // events. Ignore silently.
      break;
  }
}

/// Subscribe `state` to every `TranscriptStepName` the orchestrator
/// emits. Returns a teardown function that detaches all listeners.
export function runFromEvents(
  state: RunnerState,
  events: EventEmitter,
  stepNames: readonly string[]
): () => void {
  const handlers = stepNames.map((name) => {
    const handler = (step: TranscriptStep): void => {
      applyStep(state, step);
    };
    events.on(name, handler);
    return [name, handler] as const;
  });
  return () => {
    for (const [name, handler] of handlers) events.off(name, handler);
  };
}

function detailString(detail: Record<string, unknown> | undefined, key: string): string | null {
  if (!detail) return null;
  const v = detail[key];
  return typeof v === 'string' ? v : null;
}

function shortHash(h: string): string {
  return h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h;
}
