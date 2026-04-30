/// Agents panel — renders a list of active iNFT agents with status.
///
/// State is fully external — the agents-tui.ts entry point owns the state
/// map and re-renders on demand. This module is just a pure function from
/// state → ANSI string, easy to unit-test if we ever add tests for the TUI.

const E = '\x1b';
const RESET = `${E}[0m`;
const DIM = `${E}[2m`;
const BOLD = `${E}[1m`;
const GREEN = `${E}[38;2;0;255;136m`;
const YELLOW = `${E}[38;2;255;210;55m`;
const GRAY = `${E}[38;2;120;125;135m`;

export type AgentStatus = 'idle' | 'running' | 'done' | 'error';

export interface AgentRow {
  ens: string;
  role: string;
  status: AgentStatus;
  /// Last action description ("paying oracle", "running probe 2/3", etc.)
  lastAction: string;
  /// Wall-clock ms since the agent's last update.
  ageMs: number;
}

function statusBadge(s: AgentStatus): string {
  switch (s) {
    case 'idle':
      return `${GRAY}● idle    ${RESET}`;
    case 'running':
      return `${YELLOW}● running ${RESET}`;
    case 'done':
      return `${GREEN}● done    ${RESET}`;
    case 'error':
      return `${E}[38;2;255;80;80m● error   ${RESET}`;
  }
}

function fmtAge(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function renderAgentsPanel(rows: readonly AgentRow[]): string {
  const lines: string[] = [];
  lines.push(`${BOLD}AGENTS${RESET} ${DIM}(${rows.length} active)${RESET}`);
  lines.push(`${DIM}${'─'.repeat(60)}${RESET}`);
  if (rows.length === 0) {
    lines.push(`${DIM}  (no agents — start the demo to see live state)${RESET}`);
    return lines.join('\n');
  }
  for (const row of rows) {
    const badge = statusBadge(row.status);
    const ens = row.ens.padEnd(22);
    const role = row.role.padEnd(14);
    const action = row.lastAction.length > 36
      ? row.lastAction.slice(0, 33) + '...'
      : row.lastAction.padEnd(36);
    const age = fmtAge(row.ageMs).padStart(6);
    lines.push(`  ${badge} ${ens} ${DIM}${role}${RESET} ${action} ${DIM}${age}${RESET}`);
  }
  return lines.join('\n');
}
