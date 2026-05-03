// ── SpendCap [G] grant flow ──────────────────────────────────────────────────
//
// `G` opens a confirmation modal that calls
// `SpendCap.grantPermission(...)` on Base Sepolia using the operator's
// wallet, scoped to the staged intent's permissionId. The modal text is
// rendered by the frame builder; this module only owns the state
// transitions + the on-chain grant call.

import { keccak256, parseAbi, toHex, type Hex } from 'viem';
import type { IntentCommand } from './intent-parser.js';
import { tryBuildLiveBundle, getLiveBundleError } from './live-bundle.js';
import { pushAudit } from './audit-trail.js';
import { shortHash } from './format.js';

// Verbatim slice from contracts/src/SpendCap.sol — `grantPermission(...)`.
// The default-bucket alias `grant(...)` would also work but we use the
// per-permission API so the typed intent's hashed topic scopes the cap
// (matches what `cross-agent.ts` reads on the spend leg).
const SPENDCAP_ABI = parseAbi([
  'function grantPermission(address account, address asset, bytes32 permissionId, uint128 maxPerPeriod, uint64 periodLength, uint64 expiresAt)',
]);

const HALF_USDC_ATOMIC = 500_000n; // 0.5 USDC at 6 decimals
const ONE_HOUR_SECONDS = 3600n;
const ONE_DAY_SECONDS  = 86_400n;

export function permissionIdFor(intent: IntentCommand): Hex | null {
  // Same hash recipe the orchestrator uses (see cross-agent.ts comment
  // "Per-workflow ERC-7715 scope") so the grant we issue here matches
  // the bucket the next audit run will read.
  if (intent.kind === 'audit') return keccak256(toHex('zhgg.oracle.eu-ai-act.v1'));
  if (intent.kind === 'ask-oracle') return keccak256(toHex(`zhgg.oracle.${intent.topic}.v1`));
  return null;
}

export interface GrantEnv {
  /// The currently-staged intent (typed but not yet dispatched). Reads
  /// only — neither the modal opener nor the confirmer mutate this.
  stagedIntent: IntentCommand | null;
  /// Surface a toast (success / failure / pre-flight refusal).
  setToast: (kind: 'ok' | 'err' | 'info', text: string) => void;
  /// Set the modal lines + open flag. The render loop reads these on
  /// next tick.
  setGrantModal: (lines: string[], open: boolean) => void;
  /// Re-paint the frame after a state change (the on-chain confirm
  /// flow flips the modal closed and pushes audit rows mid-flight).
  render: () => void;
}

export function openGrantModal(env: GrantEnv): void {
  const { stagedIntent, setToast, setGrantModal } = env;
  if (!stagedIntent || stagedIntent.kind === 'empty' || stagedIntent.kind === 'unknown') {
    setToast('err', 'no intent staged — type one and Enter to stage');
    return;
  }
  const permissionId = permissionIdFor(stagedIntent);
  if (!permissionId) {
    // kh hire, swap, transfer etc. pay via x402 or direct tx — SpendCap not involved.
    setToast('info', `[G] grant is only for audit/ask-oracle — ${stagedIntent.kind} uses its own payment path`);
    return;
  }
  const bundle = tryBuildLiveBundle();
  if (!bundle) {
    setToast('err', `live env unavailable: ${getLiveBundleError() ?? 'unknown'}`);
    return;
  }
  if (!bundle.spendCap) {
    setToast('err', 'SPEND_CAP_ADDRESS not set — cannot grant');
    return;
  }
  const lines = [
    `Grant 0.5 USDC spend permission to ${bundle.baseAccount.address}`,
    `via SpendCap.grantPermission(...)`,
    ``,
    `  asset         = ${bundle.usdc}`,
    `  permissionId  = ${permissionId}`,
    `  maxPerPeriod  = 500000   (0.5 USDC, atomic)`,
    `  periodLength  = 3600s    expiresAt = now + 86400s`,
    `  spendCap      = ${bundle.spendCap}`,
  ];
  setGrantModal(lines, true);
}

export async function confirmGrant(env: GrantEnv): Promise<void> {
  const { stagedIntent, setToast, setGrantModal, render } = env;
  setGrantModal([], false);
  if (!stagedIntent) { setToast('err', 'no staged intent'); return; }
  const bundle = tryBuildLiveBundle();
  if (!bundle || !bundle.spendCap) { setToast('err', 'live env unavailable'); return; }
  const permissionId = permissionIdFor(stagedIntent);
  if (!permissionId) { setToast('err', 'staged intent has no permissionId'); return; }
  const expiresAt = BigInt(Math.floor(Date.now() / 1000)) + ONE_DAY_SECONDS;
  pushAudit('spend-cap', 'grant tx submitting…', 'info');
  render();
  try {
    const sim = await bundle.basePub.simulateContract({
      account: bundle.baseAccount,
      address: bundle.spendCap,
      abi: SPENDCAP_ABI,
      functionName: 'grantPermission',
      args: [
        bundle.baseAccount.address,
        bundle.usdc,
        permissionId,
        HALF_USDC_ATOMIC,
        ONE_HOUR_SECONDS,
        expiresAt,
      ],
    });
    const txHash = await bundle.baseWallet.writeContract(sim.request);
    await bundle.basePub.waitForTransactionReceipt({ hash: txHash });
    setToast('ok', `grant ok tx=${shortHash(txHash)}`);
    pushAudit('spend-cap', `granted 0.5 USDC tx=${shortHash(txHash)}`, 'ok');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setToast('err', `grant failed: ${msg}`.slice(0, 120));
    pushAudit('spend-cap', `grant FAILED: ${msg}`.slice(0, 120), 'err');
  }
}
