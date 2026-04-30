/// agents-tui — live demo visualization of the cross-agent loop.
///
/// Script-driven: fires a hardcoded SCRIPT array. Used for the demo
/// recording where deterministic timing matters more than realism.
/// Events-driven runner subscribing to a real orchestrator is D5 work.
///
/// Run: `bun run apps/tui:agents`

import { renderAgentsPanel, type AgentRow, type AgentStatus } from './panels/agents.js';
import { pushSplit, renderSplitsPanel, type SplitEvent } from './panels/splits.js';

const E = '\x1b';
const CLEAR = `${E}[2J${E}[H`;
const HIDE_CURSOR = `${E}[?25l`;
const SHOW_CURSOR = `${E}[?25h`;

const TICK_MS = 100;

interface State {
  agents: Map<string, AgentRow>;
  splits: SplitEvent[];
  startedAt: number;
}

function setAgent(state: State, ens: string, patch: Partial<AgentRow>): void {
  const existing = state.agents.get(ens) ?? {
    ens,
    role: '?',
    status: 'idle' as AgentStatus,
    lastAction: '',
    ageMs: 0,
  };
  state.agents.set(ens, { ...existing, ...patch });
}

function renderFrame(state: State): string {
  const now = Date.now();
  for (const row of state.agents.values()) {
    state.agents.set(row.ens, { ...row, ageMs: now - state.startedAt });
  }
  const ruler = '═'.repeat(60);
  return [
    CLEAR,
    `${E}[1mzhgg agents-tui${E}[0m  ${E}[2m(live demo visualization)${E}[0m`,
    ruler,
    '',
    renderAgentsPanel([...state.agents.values()]),
    '',
    renderSplitsPanel(state.splits),
    '',
    ruler,
  ].join('\n');
}

interface ScriptStep {
  /// Delay from the previous step (ms).
  delay: number;
  apply: (state: State) => void;
}

const SCRIPT: ScriptStep[] = [
  {
    delay: 0,
    apply: (s) => {
      setAgent(s, 'audit.zhgg.eth', {
        role: 'auditor',
        status: 'running',
        lastAction: 'requesting oracle payment',
      });
      setAgent(s, 'oracle.zhgg.eth', {
        role: 'oracle',
        status: 'running',
        lastAction: 'awaiting payment',
      });
    },
  },
  {
    delay: 600,
    apply: (s) => {
      const tMs = Date.now() - s.startedAt;
      s.splits = pushSplit(s.splits, {
        tMs,
        totalAtomic: '100000',
        asset: 'USDC',
        ownerAddress: '0x000000000000000000000000000000000000beef',
        context: 'audit → oracle',
      });
      setAgent(s, 'oracle.zhgg.eth', { lastAction: 'payment settled (Base Sepolia)' });
    },
  },
  {
    delay: 400,
    apply: (s) => {
      setAgent(s, 'oracle.zhgg.eth', { lastAction: 'querying eu-ai-act feed' });
    },
  },
  {
    delay: 700,
    apply: (s) => {
      setAgent(s, 'oracle.zhgg.eth', {
        status: 'done',
        lastAction: 'returned 3 regulatory deltas',
      });
      setAgent(s, 'audit.zhgg.eth', { lastAction: 'received oracle response' });
    },
  },
  {
    delay: 300,
    apply: (s) => {
      setAgent(s, 'audit.zhgg.eth', { lastAction: 'TEE probe 1/3 (Article 52)' });
    },
  },
  {
    delay: 800,
    apply: (s) => {
      setAgent(s, 'audit.zhgg.eth', { lastAction: 'TEE probe 2/3 (Article 6)' });
    },
  },
  {
    delay: 800,
    apply: (s) => {
      setAgent(s, 'audit.zhgg.eth', { lastAction: 'TEE probe 3/3 (Article 13)' });
    },
  },
  {
    delay: 600,
    apply: (s) => {
      setAgent(s, 'audit.zhgg.eth', { lastAction: 'verdict: compliant' });
    },
  },
  {
    delay: 400,
    apply: (s) => {
      const tMs = Date.now() - s.startedAt;
      s.splits = pushSplit(s.splits, {
        tMs,
        totalAtomic: '5000000',
        asset: 'USDC',
        ownerAddress: '0x0000000000000000000000000000000000000aud',
        context: 'user → audit',
      });
      setAgent(s, 'audit.zhgg.eth', {
        status: 'done',
        lastAction: 'erc-8004 receipt posted',
      });
    },
  },
];

/// Script-driven runner: replays a hardcoded SCRIPT for the recording.
async function runFromScript(state: State, script: readonly ScriptStep[]): Promise<void> {
  for (const step of script) {
    await new Promise((r) => setTimeout(r, step.delay));
    step.apply(state);
  }
}

// `runFromEvents` (events-driven runner subscribing to a real
// orchestrator's EventEmitter) was removed — it had zero importers and
// the script-driven path is what the demo recording uses. When D5 wires
// the TUI to a live `runCrossAgentDemo({ events })` run, the events
// runner can be reintroduced from git history (commit 4e02a8b).

async function main(): Promise<void> {
  const state: State = {
    agents: new Map(),
    splits: [],
    startedAt: Date.now(),
  };

  process.stdout.write(HIDE_CURSOR);
  const ticker = setInterval(() => {
    process.stdout.write(renderFrame(state));
  }, TICK_MS);

  const cleanup = (code: number) => {
    clearInterval(ticker);
    process.stdout.write(SHOW_CURSOR);
    process.stdout.write('\n');
    process.exit(code);
  };
  process.on('SIGINT', () => cleanup(0));

  await runFromScript(state, SCRIPT);

  // Hold final frame so the recording captures the end state.
  await new Promise((r) => setTimeout(r, 2000));
  clearInterval(ticker);
  process.stdout.write(renderFrame(state));
  process.stdout.write(SHOW_CURSOR);
  process.stdout.write('\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stdout.write(SHOW_CURSOR);
  console.error('agents-tui failed:', err);
  process.exit(1);
});
