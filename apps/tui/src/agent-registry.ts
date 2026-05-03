/// Static role-name → on-chain tokenId map for the demo agents.
///
/// The TUI takes free-form intent strings like `audit oracle` and needs
/// a deterministic, *real* tokenId to feed the cross-agent orchestrator
/// (the AgentRegistry expects a `bigint agentId` that exists on chain).
/// Names are plain role labels — no ENS suffix needed because iNFT
/// identity lives on the AgentNFT contract on 0G Galileo (chainId 16602).
///
/// Adding a new agent = mint via `bun mint-agent --tier <role>` and
/// append a row here with the printed tokenId. Keeping this file
/// dumb-and-explicit beats hiding the mapping behind an env var the
/// demo would silently fall through.

/// AgentNFT contract address on 0G Galileo (chainId 16602):
///   0x5298f4d8d8043c14e5f2683ad642febc8b54638f
/// Each row maps a role label to the iNFT `tokenId` on that contract.
/// All three tokens are owned by the deployer EOA.
export const AGENT_REGISTRY: Record<string, bigint> = {
  'audit': 1n,
  'oracle': 2n,
  'swap': 3n,
};

/// Resolve an agent role name to its on-chain iNFT tokenId.
/// Returns `null` when the name is not registered — the caller
/// surfaces a typed error so the user knows to mint first.
///
/// Lookup is case-insensitive. Also strips a trailing `.zhgg.eth`
/// suffix so legacy intent strings (`audit oracle.zhgg.eth`) still
/// resolve without requiring a TUI restart mid-session.
export function resolveAgent(name: string): bigint | null {
  const norm = name.trim().toLowerCase().replace(/\.zhgg\.eth$/i, '');
  const hit = AGENT_REGISTRY[norm];
  return hit ?? null;
}
