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

/// 0G Galileo storage explorer — submission page (preferred). The SPA
/// indexes uploaded files by `txSeq` (the indexer's monotonic submission
/// number returned at upload time), NOT by rootHash. URL pattern verified
/// with `curl -L` 2026-05-03.
///
/// Why not rootHash directly? `/tx/<rootHash>` 308-redirects to
/// chainscan-galileo (which doesn't index storage roots → "not found");
/// `?root=<rootHash>` only resolves the homepage SPA (no file view).
/// The submission view at `/submission/<txSeq>` is the canonical page.
/// The bytes themselves are always downloadable via the indexer API:
/// `https://indexer-storage-testnet-turbo.0g.ai/file?root=<rootHash>`.
export function storagescanSubmissionUrl(txSeq: number): string {
  return `https://storagescan-galileo.0g.ai/submission/${txSeq}`;
}

/// 0G Galileo storage explorer — wallet's submissions page. Useful as a
/// fallback when txSeq isn't available (e.g. mock storage paths) — points
/// the operator at every file the depositor wallet has ever uploaded.
export function storagescanAddressUrl(address: string): string {
  return `https://storagescan-galileo.0g.ai/address/${address}`;
}

/// Direct indexer download URL — returns the raw uploaded bytes (not a
/// browser-friendly view). The "regulator's verification path": fetch
/// these bytes, recompute keccak256, compare to the on-chain feedbackHash.
/// No browser page; this is the API endpoint.
export function indexerDownloadUrl(rootHash: string): string {
  return `https://indexer-storage-testnet-turbo.0g.ai/file?root=${rootHash}`;
}

/// Base Sepolia block explorer — for the FeeSplitter settlement leg + any
/// other Base-side activity (ERC-8004 receipt mirror, etc.).
export function basescanTxUrl(txHash: string): string {
  return `https://sepolia.basescan.org/tx/${txHash}`;
}
