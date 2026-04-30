/// SpendCap pre-flight gate — wires `SpendCap.sol` (ERC-7715-style) into
/// the cross-agent orchestrator. Read-only by default: simulates the cap
/// check via `capOf()`. When `enforce: true`, calls `spend()` to debit
/// the cap on-chain so concurrent agents can't both pass the read check
/// and double-spend.
///
/// Coupling note: `SpendCap.spend()` reverts unless
/// `msg.sender == account`. When `enforce: true`, the `walletClient`
/// provided here MUST sign from the same address whose cap is being
/// debited.

import { parseAbi, type Address, type Hex } from 'viem';

const SPEND_CAP_ABI = parseAbi([
  'function capOf(address account, address asset) view returns (uint128 maxPerPeriod, uint128 remaining, uint64 periodLength, uint64 currentPeriodStart, uint64 expiresAt, bool revoked, address owner)',
  'function spend(address account, address asset, uint128 amount)',
]);

export type SpendCapCheckReason =
  | 'cap_not_found'
  | 'cap_revoked'
  | 'cap_exceeded'
  | 'enforce_failed';

export type SpendCapCheckResult =
  | {
      ok: true;
      remaining: bigint;
      enforced: boolean;
      spendTx?: Hex;
    }
  | {
      ok: false;
      reason: SpendCapCheckReason;
      remaining?: bigint;
      requested?: bigint;
    };

export interface CheckSpendCapArgs {
  /// SpendCap contract address. Null → skip check entirely (fail-open).
  spendCapAddress: Address | null;
  /// The capped account. MUST equal `walletClient.account.address` when
  /// `enforce: true` because `SpendCap.spend()` reverts on msg.sender
  /// mismatch.
  account: Address;
  asset: Address;
  amount: bigint;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient: any;
  /// Required when `enforce: true`. Ignored otherwise.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  walletClient?: any;
  /// When true, calls `spend()` on-chain so concurrent caps can't double-
  /// spend. When false (default), only reads `capOf()` — racy but safe
  /// for offline / mock runs.
  enforce?: boolean;
}

export async function checkSpendCap(
  args: CheckSpendCapArgs
): Promise<SpendCapCheckResult> {
  const {
    spendCapAddress,
    account,
    asset,
    amount,
    publicClient,
    walletClient,
    enforce = false,
  } = args;

  // No SpendCap configured → fail-open. Mock-mode default.
  if (!spendCapAddress) {
    return { ok: true, remaining: 0n, enforced: false };
  }

  const capState = (await publicClient.readContract({
    address: spendCapAddress,
    abi: SPEND_CAP_ABI,
    functionName: 'capOf',
    args: [account, asset],
  })) as readonly [bigint, bigint, bigint, bigint, bigint, boolean, Address];

  const [maxPerPeriod, remaining, , , , revoked] = capState;

  if (maxPerPeriod === 0n) return { ok: false, reason: 'cap_not_found' };
  if (revoked) return { ok: false, reason: 'cap_revoked' };
  if (amount > remaining) {
    return { ok: false, reason: 'cap_exceeded', remaining, requested: amount };
  }

  // Read-only path: cap looks fine, no on-chain debit.
  if (!enforce) {
    return { ok: true, remaining: remaining - amount, enforced: false };
  }

  // Enforce path: actually call spend(). Closes the TOCTOU window between
  // read and settlement — two concurrent runs can't both pass the read
  // check and then both spend.
  if (!walletClient?.account) {
    throw new Error('checkSpendCap: enforce=true requires walletClient with account');
  }
  if (walletClient.account.address.toLowerCase() !== account.toLowerCase()) {
    throw new Error(
      'checkSpendCap: enforce=true requires walletClient.account === account ' +
        '(SpendCap.spend reverts on msg.sender mismatch)'
    );
  }

  try {
    const sim = await publicClient.simulateContract({
      account: walletClient.account,
      address: spendCapAddress,
      abi: SPEND_CAP_ABI,
      functionName: 'spend',
      args: [account, asset, amount],
    });
    const spendTx = (await walletClient.writeContract(sim.request)) as Hex;
    await publicClient.waitForTransactionReceipt({ hash: spendTx });
    return { ok: true, remaining: remaining - amount, enforced: true, spendTx };
  } catch {
    // CapExpired, race-lost CapExceeded, RPC failure — fail closed.
    return { ok: false, reason: 'enforce_failed' };
  }
}
