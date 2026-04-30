import { describe, it, expect, mock } from 'bun:test';
import { checkSpendCap } from '../src/spend-cap.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const; // USDC Base Sepolia
const SPEND_CAP = '0x9999999999999999999999999999999999999999' as const;

interface CapState {
  maxPerPeriod: bigint;
  remaining: bigint;
  revoked: boolean;
}

function mockPublicClient(state: CapState) {
  return {
    readContract: mock(async () => [
      state.maxPerPeriod,
      state.remaining,
      0n, // periodLength
      0n, // currentPeriodStart
      0n, // expiresAt
      state.revoked,
      '0xowner' as const,
    ]),
    simulateContract: mock(async () => ({ request: { __sim: true } })),
    waitForTransactionReceipt: mock(async () => ({ status: 'success' })),
  };
}

function mockWalletClient(address: `0x${string}` = ACCOUNT) {
  return {
    account: { address },
    writeContract: mock(async () => '0xspendtx' as `0x${string}`),
  };
}

describe('checkSpendCap', () => {
  it('returns ok+enforced=false when no spendCap address configured', async () => {
    const result = await checkSpendCap({
      spendCapAddress: null,
      account: ACCOUNT,
      asset: ASSET,
      amount: 100_000n,
      publicClient: { readContract: mock() },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.enforced).toBe(false);
  });

  it('returns cap_not_found when capOf returns maxPerPeriod=0', async () => {
    const publicClient = mockPublicClient({ maxPerPeriod: 0n, remaining: 0n, revoked: false });
    const result = await checkSpendCap({
      spendCapAddress: SPEND_CAP,
      account: ACCOUNT,
      asset: ASSET,
      amount: 100_000n,
      publicClient,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('cap_not_found');
  });

  it('returns cap_revoked when cap is revoked', async () => {
    const publicClient = mockPublicClient({
      maxPerPeriod: 1_000_000n,
      remaining: 500_000n,
      revoked: true,
    });
    const result = await checkSpendCap({
      spendCapAddress: SPEND_CAP,
      account: ACCOUNT,
      asset: ASSET,
      amount: 100_000n,
      publicClient,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('cap_revoked');
  });

  it('returns cap_exceeded with remaining + requested when over budget', async () => {
    const publicClient = mockPublicClient({
      maxPerPeriod: 1_000_000n,
      remaining: 50_000n,
      revoked: false,
    });
    const result = await checkSpendCap({
      spendCapAddress: SPEND_CAP,
      account: ACCOUNT,
      asset: ASSET,
      amount: 100_000n,
      publicClient,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('cap_exceeded');
    expect(result.remaining).toBe(50_000n);
    expect(result.requested).toBe(100_000n);
  });

  it('returns ok+enforced=false on read-only path with sufficient remaining', async () => {
    const publicClient = mockPublicClient({
      maxPerPeriod: 1_000_000n,
      remaining: 500_000n,
      revoked: false,
    });
    const result = await checkSpendCap({
      spendCapAddress: SPEND_CAP,
      account: ACCOUNT,
      asset: ASSET,
      amount: 100_000n,
      publicClient,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.enforced).toBe(false);
    expect(result.remaining).toBe(400_000n);
  });

  it('enforce=true calls spend() and returns spendTx', async () => {
    const publicClient = mockPublicClient({
      maxPerPeriod: 1_000_000n,
      remaining: 500_000n,
      revoked: false,
    });
    const walletClient = mockWalletClient();
    const result = await checkSpendCap({
      spendCapAddress: SPEND_CAP,
      account: ACCOUNT,
      asset: ASSET,
      amount: 100_000n,
      publicClient,
      walletClient,
      enforce: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.enforced).toBe(true);
    expect(result.spendTx).toBe('0xspendtx');
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
  });

  it('enforce=true throws when walletClient.account != account', async () => {
    const publicClient = mockPublicClient({
      maxPerPeriod: 1_000_000n,
      remaining: 500_000n,
      revoked: false,
    });
    const walletClient = mockWalletClient('0x2222222222222222222222222222222222222222');
    expect(
      checkSpendCap({
        spendCapAddress: SPEND_CAP,
        account: ACCOUNT,
        asset: ASSET,
        amount: 100_000n,
        publicClient,
        walletClient,
        enforce: true,
      })
    ).rejects.toThrow(/walletClient.account === account/);
  });

  // ----- ERC-7715 per-workflow scoping -----

  const PERM_AUDIT =
    '0x1111111111111111111111111111111111111111111111111111111111111111' as const;

  it('routes to permissionOf when permissionId is supplied', async () => {
    const publicClient = mockPublicClient({
      maxPerPeriod: 100n,
      remaining: 50n,
      revoked: false,
    });
    const result = await checkSpendCap({
      spendCapAddress: SPEND_CAP,
      account: ACCOUNT,
      asset: ASSET,
      amount: 25n,
      publicClient,
      permissionId: PERM_AUDIT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.remaining).toBe(25n);

    // Verify the call went through `permissionOf` with the 3rd arg being
    // the permissionId — proving the scoped path was taken.
    const readCall = (publicClient.readContract.mock.calls as unknown as unknown[][])[0]![0] as {
      functionName: string;
      args: readonly unknown[];
    };
    expect(readCall.functionName).toBe('permissionOf');
    expect(readCall.args[2]).toBe(PERM_AUDIT);
  });

  it('routes to capOf when permissionId is omitted (legacy path)', async () => {
    const publicClient = mockPublicClient({
      maxPerPeriod: 100n,
      remaining: 50n,
      revoked: false,
    });
    await checkSpendCap({
      spendCapAddress: SPEND_CAP,
      account: ACCOUNT,
      asset: ASSET,
      amount: 25n,
      publicClient,
      // no permissionId
    });
    const readCall = (publicClient.readContract.mock.calls as unknown as unknown[][])[0]![0] as {
      functionName: string;
      args: readonly unknown[];
    };
    expect(readCall.functionName).toBe('capOf');
    expect(readCall.args.length).toBe(2); // (account, asset) only
  });

  it('enforce=true with permissionId calls spendPermission', async () => {
    const publicClient = mockPublicClient({
      maxPerPeriod: 100n,
      remaining: 100n,
      revoked: false,
    });
    const walletClient = mockWalletClient();
    const result = await checkSpendCap({
      spendCapAddress: SPEND_CAP,
      account: ACCOUNT,
      asset: ASSET,
      amount: 30n,
      publicClient,
      walletClient,
      enforce: true,
      permissionId: PERM_AUDIT,
    });
    expect(result.ok).toBe(true);

    // Two simulateContract calls would happen if the legacy path were
    // taken; with scoping we expect exactly one (the spendPermission
    // simulation) — and its functionName must be `spendPermission`.
    const simCall = (publicClient.simulateContract.mock.calls as unknown as unknown[][])[0]![0] as {
      functionName: string;
      args: readonly unknown[];
    };
    expect(simCall.functionName).toBe('spendPermission');
    expect(simCall.args[2]).toBe(PERM_AUDIT);
  });
});
