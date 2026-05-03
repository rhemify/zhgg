/// Block-explorer URL helpers — single source of truth for the URLs we
/// surface to operators / judges when rendering tx hashes + storage roots.
///
/// Modern terminals (iTerm2, kitty, Alacritty, etc.) auto-detect URL patterns
/// in stdout and render them as cmd-clickable / right-click-openable. We
/// emit plain URLs (not OSC 8 hyperlink-wrapped) so the same string works
/// in less-fancy terminals too — falls back to "copy this URL" UX.
///
/// Lives in `apps/demo/src/` so both the demo CLI and the TUI (which already
/// cross-imports from `../../demo/src/cross-agent.js`) can share without
/// duplicating URL patterns. Patterns sourced from `docs/0g.md:33-37,69`
/// (0G testnet explorers) and existing usage in
/// `apps/tui/src/orchestrator-step.ts:114,149` +
/// `apps/keeperhub-agent/src/index.ts:264`.

/// 0G Galileo block explorer — for any 0G chain transaction (AxiomCommit
/// commit/reveal, AgentRegistry giveFeedback, AgentNFT memoryRoot pin,
/// 0G Storage upload tx).
export function chainscanTxUrl(txHash: string): string {
  return `https://chainscan-galileo.0g.ai/tx/${txHash}`;
}

/// 0G Galileo storage explorer — for content lookup by rootHash. Lets a
/// regulator fetch the canonical AuditReport bytes pinned at upload time
/// and re-verify the keccak256 against the on-chain feedbackHash.
export function storagescanRootUrl(rootHash: string): string {
  return `https://storagescan-galileo.0g.ai/tx/${rootHash}`;
}

/// Base Sepolia block explorer — for the FeeSplitter settlement leg + any
/// other Base-side activity (ERC-8004 receipt mirror, etc.).
export function basescanTxUrl(txHash: string): string {
  return `https://sepolia.basescan.org/tx/${txHash}`;
}
