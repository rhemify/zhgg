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
const SPENDCAP_ABI = parseAbi([
  'function grantPermission(address account, address asset, bytes32 permissionId, uint128 maxPerPeriod, uint64 periodLength, uint64 expiresAt)',
]);

const ONE_HOUR_SECONDS = 3600n;
const ONE_DAY_SECONDS  = 86_400n;

function parseCapAtomic(capStr: string): bigint {
  const usdc = parseFloat(capStr);
  if (isNaN(usdc) || usdc <= 0) return 500_000n; // fall back to 0.5 USDC
  return BigInt(Math.round(usdc * 1_000_000));
}

export function permissionIdFor(intent: IntentCommand): Hex | null {
  if (intent.kind === 'audit') return keccak256(toHex('zhgg.oracle.eu-ai-act.v1'));
  if (intent.kind === 'ask-oracle') return keccak256(toHex(`zhgg.oracle.${intent.topic}.v1`));
  return null;
}

export interface GrantEnv {
  stagedIntent: IntentCommand | null;
  /// Current cap amount string — editable by the user while the modal is open.
  capStr: string;
  setToast: (kind: 'ok' | 'err' | 'info', text: string) => void;
  setGrantModal: (lines: string[], open: boolean) => void;
  render: () => void;
}

const DEFAULT_AUDIT_PERMISSION_ID = keccak256(toHex('zhgg.oracle.eu-ai-act.v1'));

export function buildGrantLines(
  bundle: ReturnType<typeof tryBuildLiveBundle>,
  permissionId: Hex,
  bucketLabel: string,
  capStr: string,
): string[] {
  const capAtomic = parseCapAtomic(capStr);
  const displayVal = capStr || '0';
  return [
    `Grant ${displayVal} USDC spend cap  [${bucketLabel}]`,
    ``,
    `  account       = ${bundle!.baseAccount.address}`,
    `  asset         = ${bundle!.usdc}`,
    `  permissionId  = ${permissionId}`,
    `  maxPerPeriod  = ${capAtomic}   (${displayVal} USDC, atomic)`,
    `  periodLength  = 3600s    expiresAt = now + 86400s`,
    `  spendCap      = ${bundle!.spendCap}`,
    ``,
    `  Amount: [${displayVal}] USDC  ← type to edit, [Enter] confirm, [Esc] cancel`,
  ];
}

export function openGrantModal(env: GrantEnv): void {
  const { stagedIntent, capStr, setToast, setGrantModal } = env;

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

export async function confirmGrant(env: GrantEnv): Promise<void> {
  const { stagedIntent, capStr, setToast, setGrantModal, render } = env;
  setGrantModal([], false);
  const bundle = tryBuildLiveBundle();
  if (!bundle || !bundle.spendCap) { setToast('err', 'live env unavailable'); return; }
  const permissionId = (stagedIntent && stagedIntent.kind !== 'empty' && stagedIntent.kind !== 'unknown')
    ? permissionIdFor(stagedIntent) ?? DEFAULT_AUDIT_PERMISSION_ID
    : DEFAULT_AUDIT_PERMISSION_ID;
  const capAtomic = parseCapAtomic(capStr);
  const capDisplay = capStr || '0.5';
  const expiresAt = BigInt(Math.floor(Date.now() / 1000)) + ONE_DAY_SECONDS;
  pushAudit('spend-cap', `grant tx submitting… (${capDisplay} USDC)`, 'info');
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
    pushAudit('spend-cap', `granted ${capDisplay} USDC tx=${shortHash(txHash)}`, 'ok');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setToast('err', `grant failed: ${msg}`.slice(0, 120));
    pushAudit('spend-cap', `grant FAILED: ${msg}`.slice(0, 120), 'err');
  }
}
