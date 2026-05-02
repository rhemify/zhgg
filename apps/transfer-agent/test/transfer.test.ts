import { describe, expect, it } from 'bun:test';
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import { executeTransfer } from '../src/index.ts';

const STUB_TX_FOR_TEST: Hex = '0xfeedface00000000000000000000000000000000000000000000000000000002';
const SENDER: Address = '0x1111111111111111111111111111111111111111';
const RECIPIENT_ADDR: Address = '0x2222222222222222222222222222222222222222';

interface MockState {
  ethBalance: bigint;
  erc20Balance: bigint;
  writes: Array<{ functionName: string; args: readonly unknown[] }>;
  sends: Array<{ to: Address; value: bigint }>;
}

function makeMocks(state: MockState, opts: { writeThrows?: Error } = {}): {
  basePub: PublicClient;
  baseWallet: WalletClient;
} {
  const basePub = {
    getBalance: async ({ address }: { address: Address }) => {
      void address;
      return state.ethBalance;
    },
    getGasPrice: async () => 1_000_000_000n, // 1 gwei
    estimateGas: async () => 21_000n,
    readContract: async () => state.erc20Balance,
    simulateContract: async ({
      functionName,
      args,
    }: {
      functionName: string;
      args: readonly unknown[];
    }) => ({
      request: { functionName, args },
    }),
    waitForTransactionReceipt: async () => ({
      status: 'success' as const,
      blockNumber: 1234n,
      gasUsed: 21_000n,
    }),
  } as unknown as PublicClient;

  const baseWallet = {
    account: { address: SENDER },
    sendTransaction: async ({ to, value }: { to: Address; value: bigint }) => {
      if (opts.writeThrows) throw opts.writeThrows;
      state.sends.push({ to, value });
      return STUB_TX_FOR_TEST;
    },
    writeContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      if (opts.writeThrows) throw opts.writeThrows;
      state.writes.push({ functionName, args });
      return STUB_TX_FOR_TEST;
    },
  } as unknown as WalletClient;

  return { basePub, baseWallet };
}

describe('executeTransfer', () => {
  it('rejects unsupported symbols', async () => {
    const state: MockState = { ethBalance: 10n ** 18n, erc20Balance: 0n, writes: [], sends: [] };
    const { basePub, baseWallet } = makeMocks(state);
    const r = await executeTransfer({
      amount: '1',
      symbol: 'DAI',
      recipient: RECIPIENT_ADDR,
      basePub,
      baseWallet,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('unsupported_symbol');
  });

  it('rejects malformed amount', async () => {
    const state: MockState = { ethBalance: 10n ** 18n, erc20Balance: 0n, writes: [], sends: [] };
    const { basePub, baseWallet } = makeMocks(state);
    const r = await executeTransfer({
      amount: '0.0.1',
      symbol: 'ETH',
      recipient: RECIPIENT_ADDR,
      basePub,
      baseWallet,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('invalid_amount');
  });

  it('rejects zero amount', async () => {
    const state: MockState = { ethBalance: 10n ** 18n, erc20Balance: 0n, writes: [], sends: [] };
    const { basePub, baseWallet } = makeMocks(state);
    const r = await executeTransfer({
      amount: '0',
      symbol: 'ETH',
      recipient: RECIPIENT_ADDR,
      basePub,
      baseWallet,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('invalid_amount');
  });

  it('rejects garbage recipient', async () => {
    const state: MockState = { ethBalance: 10n ** 18n, erc20Balance: 0n, writes: [], sends: [] };
    const { basePub, baseWallet } = makeMocks(state);
    const r = await executeTransfer({
      amount: '1',
      symbol: 'ETH',
      recipient: 'not-a-real-recipient',
      basePub,
      baseWallet,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('invalid_recipient');
  });

  it('sends native ETH via sendTransaction (no contract call)', async () => {
    const state: MockState = {
      ethBalance: 10n ** 18n, // 1 ETH
      erc20Balance: 0n,
      writes: [],
      sends: [],
    };
    const { basePub, baseWallet } = makeMocks(state);
    const r = await executeTransfer({
      amount: '0.001',
      symbol: 'ETH',
      recipient: RECIPIENT_ADDR,
      basePub,
      baseWallet,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.txHash).toBe(STUB_TX_FOR_TEST);
    expect(r.value.recipientSource).toBe('address');
    expect(r.value.amountAtomic).toBe(10n ** 15n); // 0.001 * 1e18
    expect(state.sends).toHaveLength(1);
    expect(state.sends[0]?.to).toBe(RECIPIENT_ADDR);
    expect(state.sends[0]?.value).toBe(10n ** 15n);
    expect(state.writes).toHaveLength(0); // native path never calls a contract
  });

  it('sends USDC via ERC-20 transfer call', async () => {
    const state: MockState = {
      ethBalance: 10n ** 18n,
      erc20Balance: 100_000_000n, // 100 USDC
      writes: [],
      sends: [],
    };
    const { basePub, baseWallet } = makeMocks(state);
    const r = await executeTransfer({
      amount: '5',
      symbol: 'USDC',
      recipient: RECIPIENT_ADDR,
      basePub,
      baseWallet,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.amountAtomic).toBe(5_000_000n); // 5 * 1e6
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]?.functionName).toBe('transfer');
    expect(state.writes[0]?.args).toEqual([RECIPIENT_ADDR, 5_000_000n]);
    expect(state.sends).toHaveLength(0); // ERC-20 path never sends native
  });

  it('bubbles real revert reason — never invents a hash', async () => {
    const state: MockState = {
      ethBalance: 10n ** 18n,
      erc20Balance: 100_000_000n,
      writes: [],
      sends: [],
    };
    const { basePub, baseWallet } = makeMocks(state, {
      writeThrows: new Error('execution reverted: ERC20: transfer to the zero address'),
    });
    const r = await executeTransfer({
      amount: '5',
      symbol: 'USDC',
      recipient: RECIPIENT_ADDR,
      basePub,
      baseWallet,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('execution_reverted');
    expect(r.error.reason).toContain('ERC20: transfer to the zero address');
    // No fake hash was returned.
    expect((r as { value?: unknown }).value).toBeUndefined();
  });

  it('rejects when ERC-20 balance is short', async () => {
    const state: MockState = {
      ethBalance: 10n ** 18n,
      erc20Balance: 1_000_000n, // 1 USDC
      writes: [],
      sends: [],
    };
    const { basePub, baseWallet } = makeMocks(state);
    const r = await executeTransfer({
      amount: '5',
      symbol: 'USDC',
      recipient: RECIPIENT_ADDR,
      basePub,
      baseWallet,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('execution_reverted');
    expect(r.error.reason).toContain('insufficient ERC-20 balance');
  });
});
