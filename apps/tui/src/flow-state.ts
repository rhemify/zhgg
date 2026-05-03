// ── Payment flow state ───────────────────────────────────────────────────────
//
// Slice C: the FLOW panel reflects only what the orchestrator
// transcript actually emitted. No synthetic FLOW_STEPS, no auto-play.
// The two rails are `x402` (KeeperHub facilitator) and `direct_split`
// (FeeSplitter on Base Sepolia) — those are the only values
// `SettleOutput.rail` ever carries.

export type NS = 'off' | 'active' | 'done' | 'rejected';

/// The settled rail, read from `oracle.payment.settle` detail.rail.
/// `null` when no settle has been observed yet.
export type SettledRail = 'x402' | 'direct_split' | null;

export interface FlowState {
  nodes: [NS, NS, NS, NS]; // intent, policy, rails, execute
  rails: { x402: NS; direct_split: NS };
  /// Pretty label for the FLOW panel header pill — set when a settle event
  /// arrives. Stays null before settle and across resets.
  settledRail: SettledRail;
  /// True once any node has reached a terminal state — used by the status
  /// footer to show "COMPLETE" / "REJECTED" instead of "WAITING".
  complete: boolean;
}

export const mkFlow = (): FlowState => ({
  nodes: ['off', 'off', 'off', 'off'],
  rails: { x402: 'off', direct_split: 'off' },
  settledRail: null,
  complete: false,
});
