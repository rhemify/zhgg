// ── SpendCap [G] grant flow ──────────────────────────────────────────────────
//
// `G` opens a confirmation modal that calls
// `SpendCap.grantPermission(...)` on Base Sepolia using the operator's
// wallet, scoped to the staged intent's permissionId. The modal text is
// rendered by the frame builder; this module only owns the state
// transitions + the on-chain grant call.

import { keccak256, parseAbi, toHex, type Hex } from 'viem';
import type { IntentCommand } from './intent-parser.js';
import { tryBuildLiveBundle, getLiveBundleError, type LiveBundle } from './live-bundle.js';
import { pushAudit } from './audit-trail.js';
import { shortHash } from './format.js';

// Verbatim slice from contracts/src/SpendCap.sol — `grantPermission(...)`.
// The default-bucket alias `grant(...)` would also work but we use the
// per-permission API so the typed intent's hashed topic scopes the cap
// (matches what `cross-agent.ts` reads on the spend leg).
const SPENDCAP_ABI = parseAbi([
  'function grantPermission(address account, address asset, bytes32 permissionId, uint128 maxPerPeriod, uint64 periodLength, uint64 expiresAt)',
]);

const ONE_HOUR_SECONDS = 3600n;
const ONE_DAY_SECONDS  = 86_400n;

function parseCapAtomic(capStr: string): bigint {
  const usdc = parseFloat(capStr);
  if (!isFinite(usdc) || usdc <= 0) return 500_000n;
  return BigInt(Math.round(usdc * 1_000_000));
}

export function buildGrantLines(
  bundle: LiveBundle,
  permissionId: Hex,
  bucketLabel: string,
  capStr: string,
): string[] {
  const capAtomic = parseCapAtomic(capStr);
  return [
    `Grant ${capStr} USDC spend cap  [${bucketLabel}]`,
    ``,
    `  account       = ${bundle.baseAccount.address}`,
    `  asset         = ${bundle.usdc}`,
    `  permissionId  = ${permissionId}`,
    `  maxPerPeriod  = ${capAtomic}   (${capStr} USDC, atomic)`,
    `  periodLength  = 3600s    expiresAt = now + 86400s`,
    `  spendCap      = ${bundle.spendCap}`,
    ``,
    `  amount (USDC): ${capStr}_`,
  ];
}

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
  /// Editable spend cap string (e.g. '0.5'). Operator types a new value
  /// while the modal is open; confirmGrant parses it to atomic units.
  capStr: string;
  /// Surface a toast (success / failure / pre-flight refusal).
  setToast: (kind: 'ok' | 'err' | 'info', text: string) => void;
  /// Set the modal lines + open flag. The render loop reads these on
  /// next tick.
  setGrantModal: (lines: string[], open: boolean) => void;
  /// Re-paint the frame after a state change (the on-chain confirm
  /// flow flips the modal closed and pushes audit rows mid-flight).
  render: () => void;
}

// Default permissionId used when no intent is staged — matches the audit
// workflow bucket so [G] works at any time without requiring a staged intent.
const DEFAULT_AUDIT_PERMISSION_ID = keccak256(toHex('zhgg.oracle.eu-ai-act.v1'));

export function openGrantModal(env: GrantEnv): void {
  const { stagedIntent, capStr, setToast, setGrantModal } = env;

  // Resolve permissionId from staged intent, or fall back to the audit bucket
  // so [G] works at any time — no need to stage an intent first.
  let permissionId: Hex | null = null;
  if (stagedIntent && stagedIntent.kind !== 'empty' && stagedIntent.kind !== 'unknown') {
    permissionId = permissionIdFor(stagedIntent);
    if (!permissionId) {
      setToast('info', `[G] grant is for audit/ask-oracle — ${stagedIntent.kind} uses its own payment path`);
      return;
    }
  } else {
    permissionId = DEFAULT_AUDIT_PERMISSION_ID;
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
  const bucketLabel = (stagedIntent && permissionId !== DEFAULT_AUDIT_PERMISSION_ID)
    ? `${stagedIntent.kind} workflow`
    : 'audit (eu-ai-act) — default bucket';
  setGrantModal(buildGrantLines(bundle, permissionId, bucketLabel, capStr), true);
}

export function rebuildGrantLines(env: GrantEnv): string[] | null {
  const { stagedIntent, capStr } = env;
  let permissionId: Hex | null = null;
  if (stagedIntent && stagedIntent.kind !== 'empty' && stagedIntent.kind !== 'unknown') {
    permissionId = permissionIdFor(stagedIntent);
    if (!permissionId) return null;
  } else {
    permissionId = DEFAULT_AUDIT_PERMISSION_ID;
  }
  const bundle = tryBuildLiveBundle();
  if (!bundle?.spendCap) return null;
  const bucketLabel = (stagedIntent && permissionId !== DEFAULT_AUDIT_PERMISSION_ID)
    ? `${stagedIntent.kind} workflow`
    : 'audit (eu-ai-act) — default bucket';
  return buildGrantLines(bundle, permissionId, bucketLabel, capStr);
}

export async function confirmGrant(env: GrantEnv): Promise<void> {
  const { stagedIntent, capStr, setToast, setGrantModal, render } = env;
  setGrantModal([], false);
  const bundle = tryBuildLiveBundle();
  if (!bundle || !bundle.spendCap) { setToast('err', 'live env unavailable'); return; }
  const permissionId = (stagedIntent && stagedIntent.kind !== 'empty' && stagedIntent.kind !== 'unknown')
    ? permissionIdFor(stagedIntent) ?? DEFAULT_AUDIT_PERMISSION_ID
    : DEFAULT_AUDIT_PERMISSION_ID;
  const capAtomic = parseCapAtomic(capStr);
  const expiresAt = BigInt(Math.floor(Date.now() / 1000)) + ONE_DAY_SECONDS;
  pushAudit('spend-cap', `grant tx submitting… (${capStr} USDC)`, 'info');
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
        capAtomic,
        ONE_HOUR_SECONDS,
        expiresAt,
      ],
    });
    const txHash = await bundle.baseWallet.writeContract(sim.request);
    await bundle.basePub.waitForTransactionReceipt({ hash: txHash });
    setToast('ok', `grant ok tx=${shortHash(txHash)}`);
    pushAudit('spend-cap', `granted ${capStr} USDC tx=${shortHash(txHash)}`, 'ok');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setToast('err', `grant failed: ${msg}`.slice(0, 120));
    pushAudit('spend-cap', `grant FAILED: ${msg}`.slice(0, 120), 'err');
  }
}
