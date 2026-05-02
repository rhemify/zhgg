/// Static `*.zhgg.eth` → on-chain tokenId map for the demo agents.
///
/// The TUI takes free-form intent strings like `audit oracle.zhgg.eth`
/// and needs a deterministic, *real* tokenId to feed the cross-agent
/// orchestrator (the AgentRegistry expects a `bigint agentId` that
/// exists on chain). We don't run an on-chain ENS→tokenId resolver
/// because zhgg.eth isn't registered on mainnet; instead we hardcode
/// the three iNFTs we minted on 0G Galileo (chainId 16602).
///
/// Adding a new agent = mint via `bun mint-agent --tier <role>` and
/// append a row here with the printed tokenId. Keeping this file
/// dumb-and-explicit beats hiding the mapping behind an env var the
/// demo would silently fall through.

/// AgentNFT contract address on 0G Galileo (chainId 16602):
///   0x5298f4d8d8043c14e5f2683ad642febc8b54638f
/// Each row maps a `*.zhgg.eth` label to the iNFT `tokenId` on that
/// contract. All three tokens are owned by the deployer EOA.
export const AGENT_REGISTRY: Record<string, bigint> = {
  'audit.zhgg.eth': 1n,
  'oracle.zhgg.eth': 2n,
  'swap.zhgg.eth': 3n,
};

/// Resolve an ENS-shaped agent name to its on-chain iNFT tokenId.
/// Returns `null` when the name is not registered — the caller
/// surfaces a typed error so the user knows to mint first.
///
/// Lookup is case-insensitive on the label portion (`Oracle.zhgg.eth`
/// → `oracle.zhgg.eth`) because shells preserve case but DNS-style
/// names are canonically lower.
export function resolveAgent(name: string): bigint | null {
  const norm = name.trim().toLowerCase();
  const hit = AGENT_REGISTRY[norm];
  return hit ?? null;
}
