/// Swap-agent unit tests — verify the V3 path constructs correct
/// `exactInputSingle` params and that errors bubble up (no synthetic
/// fallback / fake txHash).
///
/// We pass a mock `publicClient` + `walletClient` that intercept the
/// viem methods we exercise (readContract / simulateContract /
/// writeContract / waitForTransactionReceipt) so the test runs offline.

import { describe, expect, it, mock } from 'bun:test';
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import { executeSwap, TOKEN_ADDRESSES } from '../src/index.js';
import { SWAP_ROUTER_02, V3_FACTORY } from '../src/uniswap-v3.js';
import { WETH9_BASE_SEPOLIA } from '../src/wrap-fallback.js';

const ACCOUNT: Address = '0x557E1E07652B75ABaA667223B11704165fC94d09';
const POOL_500: Address = '0x94bfc0574FF48E92cE43d495376C477B1d0EEeC0';
const FAKE_TX: Hex = '0xfeedface00000000000000000000000000000000000000000000000000000001';
const ZERO_ADDR: Address = '0x0000000000000000000000000000000000000000';

interface MockState {
  readCalls: Array<{ functionName: string; args: readonly unknown[]; address: Address }>;
  simulateCalls: Array<{ functionName: string; args: readonly unknown[]; address: Address; value?: bigint }>;
  writeCallArgs: Array<{ functionName?: string; args?: readonly unknown[]; address?: Address; value?: bigint }>;
  /// Allow individual tests to override pool resolution per (tokenA,tokenB,fee).
  poolFor: (tokenA: Address, tokenB: Address, fee: number) => Address;
  /// Allow individual tests to override what writeContract throws (or which
  /// hash it returns).
  writeImpl: () => Promise<Hex>;
}

function makeClients(state: MockState): { publicClient: PublicClient; walletClient: WalletClient } {
  const publicClient = {
    readContract: mock(async (call: { functionName: string; args: readonly unknown[]; address: Address }) => {
      state.readCalls.push(call);
      if (call.address === V3_FACTORY && call.functionName === 'getPool') {
        const [a, b, fee] = call.args as [Address, Address, number];
        return state.poolFor(a, b, fee);
      }
      if (call.functionName === 'allowance') {
        // Pretend the user has not approved yet → triggers an approve tx.
        return 0n;
      }
      throw new Error(`unexpected readContract: ${call.functionName}`);
    }),
    simulateContract: mock(async (call: { functionName: string; args: readonly unknown[]; address: Address; value?: bigint }) => {
      state.simulateCalls.push(call);
      return { request: call };
    }),
    waitForTransactionReceipt: mock(async () => ({ status: 'success' })),
  } as unknown as PublicClient;

  const walletClient = {
    writeContract: mock(async (call: { functionName?: string; args?: readonly unknown[]; address?: Address; value?: bigint }) => {
      state.writeCallArgs.push(call);
      return state.writeImpl();
    }),
  } as unknown as WalletClient;

  return { publicClient, walletClient };
}

function freshState(overrides: Partial<MockState> = {}): MockState {
  return {
    readCalls: [],
    simulateCalls: [],
    writeCallArgs: [],
    poolFor: () => POOL_500, // default: 500-tier pool exists
    writeImpl: async () => FAKE_TX,
    ...overrides,
  };
}

describe('executeSwap — symbol validation', () => {
  it('returns unsupported_symbol for unknown from-symbol', async () => {
    const state = freshState();
    const clients = { ...makeClients(state), account: ACCOUNT };
    const result = await executeSwap(clients, '1', 'BTC', 'USDC');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('unsupported_symbol');
  });

  it('returns unsupported_symbol for unknown to-symbol', async () => {
    const state = freshState();
    const clients = { ...makeClients(state), account: ACCOUNT };
    const result = await executeSwap(clients, '1', 'ETH', 'DAI');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('unsupported_symbol');
  });

  it('rejects same-symbol swaps', async () => {
    const state = freshState();
    const clients = { ...makeClients(state), account: ACCOUNT };
    const result = await executeSwap(clients, '1', 'ETH', 'ETH');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('invalid_amount');
  });

  it('rejects unparseable amount', async () => {
    const state = freshState();
    const clients = { ...makeClients(state), account: ACCOUNT };
    const result = await executeSwap(clients, 'not-a-number', 'ETH', 'USDC');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('invalid_amount');
  });
});

describe('executeSwap — Uniswap V3 ETH → USDC', () => {
  it('constructs exactInputSingle with the right tuple', async () => {
    const state = freshState();
    const clients = { ...makeClients(state), account: ACCOUNT };
    const result = await executeSwap(clients, '0.001', 'ETH', 'USDC');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.txHash).toBe(FAKE_TX);
    expect(result.value.route).toBe('uniswap_v3');
    expect(result.value.poolFee).toBe(500);
    expect(result.value.fromAmount).toBe(10n ** 15n); // 0.001 ETH = 1e15 wei

    // ETH-in path uses multicall(exactInputSingle, refundETH).
    const swapSim = state.simulateCalls.find((c) => c.functionName === 'multicall');
    expect(swapSim).toBeDefined();
    expect(swapSim!.address).toBe(SWAP_ROUTER_02);
    expect(swapSim!.value).toBe(10n ** 15n);
    // The first inner call's encoded data should embed the params tuple.
    const [data] = swapSim!.args as [Hex[]];
    expect(data.length).toBe(2);
  });

  it('walks fee tiers in order and picks the first non-zero pool', async () => {
    const state = freshState({
      poolFor: (_a, _b, fee) => (fee === 3000 ? POOL_500 : ZERO_ADDR),
    });
    const clients = { ...makeClients(state), account: ACCOUNT };
    const result = await executeSwap(clients, '0.001', 'ETH', 'USDC');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.poolFee).toBe(3000);

    // Probed 500 (zero) then 3000 (non-zero) — but NOT 10000.
    const probes = state.readCalls.filter((c) => c.functionName === 'getPool');
    expect(probes.length).toBe(2);
  });

  it('returns no_pool when every fee tier is zero — no synthetic fallback', async () => {
    const state = freshState({
      poolFor: () => ZERO_ADDR,
    });
    const clients = { ...makeClients(state), account: ACCOUNT };
    const result = await executeSwap(clients, '0.001', 'ETH', 'USDC');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('no_pool');
    // No write was attempted.
    expect(state.writeCallArgs.length).toBe(0);
  });

  it('bubbles up writeContract revert as execution_reverted (no fake hash)', async () => {
    const state = freshState({
      writeImpl: async () => {
        throw new Error('execution reverted: STF');
      },
    });
    const clients = { ...makeClients(state), account: ACCOUNT };
    const result = await executeSwap(clients, '0.001', 'ETH', 'USDC');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('execution_reverted');
    expect(result.error.reason).toContain('STF');
  });
});

describe('executeSwap — USDC → ETH', () => {
  it('approves USDC then submits multicall(swap, unwrapWETH9)', async () => {
    const state = freshState();
    const clients = { ...makeClients(state), account: ACCOUNT };
    const result = await executeSwap(clients, '5', 'USDC', 'ETH');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    // Two writeContract calls: approve (direct, no simulate) + multicall (sim+write).
    expect(state.writeCallArgs.length).toBe(2);

    // The simulate for `multicall` should have value=0 (ERC-20 in).
    const mc = state.simulateCalls.find((c) => c.functionName === 'multicall');
    expect(mc).toBeDefined();
    expect(mc!.value ?? 0n).toBe(0n);

    // The approve write was directed at USDC.
    const approveWrite = state.writeCallArgs.find((c) => c.functionName === 'approve');
    expect(approveWrite).toBeDefined();
    expect(approveWrite!.address).toBe(TOKEN_ADDRESSES.USDC);
    const [spender] = approveWrite!.args as [Address, bigint];
    expect(spender).toBe(SWAP_ROUTER_02);
  });
});

describe('executeSwap — WETH9 wrap fallback', () => {
  it('ETH → WETH calls deposit() with value', async () => {
    const state = freshState();
    const clients = { ...makeClients(state), account: ACCOUNT };
    const result = await executeSwap(clients, '0.0001', 'ETH', 'WETH');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.route).toBe('weth9_deposit');
    expect(result.value.poolFee).toBeNull();

    const sim = state.simulateCalls.find((c) => c.functionName === 'deposit');
    expect(sim).toBeDefined();
    expect(sim!.address).toBe(WETH9_BASE_SEPOLIA);
    expect(sim!.value).toBe(10n ** 14n);
  });

  it('WETH → ETH calls withdraw(amount)', async () => {
    const state = freshState();
    const clients = { ...makeClients(state), account: ACCOUNT };
    const result = await executeSwap(clients, '0.0001', 'WETH', 'ETH');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.route).toBe('weth9_withdraw');

    const sim = state.simulateCalls.find((c) => c.functionName === 'withdraw');
    expect(sim).toBeDefined();
    expect(sim!.address).toBe(WETH9_BASE_SEPOLIA);
    const [amt] = sim!.args as [bigint];
    expect(amt).toBe(10n ** 14n);
  });
});
