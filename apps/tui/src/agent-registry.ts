/// Static role-name → on-chain identity map for the demo agents.
///
/// The TUI takes free-form intent strings like `audit oracle` and needs
/// deterministic, *real* on-chain identifiers to feed downstream
/// systems. zhgg uses TWO on-chain ERC-721 contracts that mint in
/// parallel via `bun mint-agent`:
///
///   - AgentNFT (0G Galileo, ERC-7857 iNFT) — the agent's identity +
///     capabilities. Used for AxiomCommit, readCapabilities, memoryRoot.
///     We call this `inftTokenId`.
///   - AgentRegistry (0G Galileo, ERC-8004) — the reputation passport.
///     `giveFeedback(agentId, …)` lives here. We call this
///     `registryAgentId`.
///
/// Each contract has its OWN incrementing counter. They happen to align
/// for the current deployment because mint-agent always mints to BOTH
/// in the same run, AgentRegistry was never used outside mint-agent,
/// and both counters started at 1. If that ever drifts (e.g., someone
/// registers an agent via a script that touches AgentRegistry without
/// AgentNFT), the static `registryAgentId` below MUST be updated.
///
/// Adding a new agent = mint via `bun mint-agent --tier <role>` and
/// append a row here with the printed tokenIds. A future follow-up
/// (`bun mint-agent verify-registry`) will read both contracts and
/// print the actual mapping for verification — see
/// `docs/PHASE-C-PARTNER-BLOCKER.md`'s out-of-scope notes.

export interface AgentEntry {
  /// AgentNFT (ERC-7857 iNFT) tokenId on 0G Galileo. Used by
  /// AxiomCommit.commitPlan, readCapabilities, memoryRoot pin, and
  /// the canonical AuditReport's `subjectAgent.tokenId`.
  inftTokenId: bigint;
  /// AgentRegistry (ERC-8004) agentId on 0G Galileo. Used by
  /// `giveFeedback(agentId, …)` ONLY. Different from `inftTokenId`
  /// in principle (separate ERC-721 with its own counter); aligned
  /// for current deployment by mint-agent's parallel-mint flow.
  registryAgentId: bigint;
  /// ENS-shaped label used as the AuditReport's `auditorAgent.ens`
  /// or `subjectAgent.ens` field. Not a real ENS resolution today
  /// (zhgg.eth not registered on mainnet) — pure label string.
  ens: string;
}

/// Contract addresses on 0G Galileo (chainId 16602):
///   AgentNFT       0x5298f4d8d8043c14e5f2683ad642febc8b54638f
///   AgentRegistry  0xe78f6c235fd1686547dbea41f742d649607316b1
/// All three demo agents are owned by the deployer EOA.
export const AGENT_REGISTRY: Record<string, AgentEntry> = {
  'audit':  { inftTokenId: 1n, registryAgentId: 1n, ens: 'audit.zhgg.eth' },
  'oracle': { inftTokenId: 2n, registryAgentId: 2n, ens: 'oracle.zhgg.eth' },
  'swap':   { inftTokenId: 3n, registryAgentId: 3n, ens: 'swap.zhgg.eth' },
};

/// Resolve a role name to its full on-chain identity entry. Returns
/// `null` when the name is not registered — the caller surfaces a
/// typed error so the user knows to mint first.
///
/// Lookup is case-insensitive. Also strips a trailing `.zhgg.eth`
/// suffix so legacy intent strings (`audit oracle.zhgg.eth`) still
/// resolve without requiring a TUI restart mid-session.
export function resolveAgent(name: string): AgentEntry | null {
  const norm = name.trim().toLowerCase().replace(/\.zhgg\.eth$/i, '');
  return AGENT_REGISTRY[norm] ?? null;
}

/// Backward-compat shim — many callers only need the iNFT tokenId
/// (TUI display, AgentNFT-side reads). Use this rather than dipping
/// into `AGENT_REGISTRY[name].inftTokenId` so the call site stays
/// resilient to future shape changes.
export function resolveAgentTokenId(name: string): bigint | null {
  return resolveAgent(name)?.inftTokenId ?? null;
}
