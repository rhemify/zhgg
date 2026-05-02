/// WETH9 wrap / unwrap fallback.
///
/// When the Uniswap V3 path is unavailable for a given pair (no pool
/// at any fee tier), the swap-agent surfaces `no_pool` rather than
/// inventing a tx. The two pairs that DON'T need a pool are
/// ETH ↔ WETH — those are handled here against the canonical Base
/// Sepolia WETH9 (`0x4200…0006`).
///
/// `deposit()` is `payable`; user sends `amount` wei and receives an
/// equal amount of WETH back. `withdraw(amount)` burns WETH and
/// transfers ETH back. Both are 1:1, no fees.

import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';

/// Canonical Base Sepolia WETH9 (matches mainnet/L2 OP-stack convention).
export const WETH9_BASE_SEPOLIA: Address = '0x4200000000000000000000000000000000000006';

const WETH9_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
  },
] as const;

export interface WrapDeps {
  publicClient: PublicClient;
  walletClient: WalletClient;
}

export interface WrapArgs {
  account: Address;
  amount: bigint;
}

/// ETH → WETH via `deposit()` payable. Returns the real tx hash.
export async function depositEthToWeth(deps: WrapDeps, args: WrapArgs): Promise<Hex> {
  const sim = await deps.publicClient.simulateContract({
    account: args.account,
    address: WETH9_BASE_SEPOLIA,
    abi: WETH9_ABI,
    functionName: 'deposit',
    args: [],
    value: args.amount,
  });
  return deps.walletClient.writeContract(sim.request);
}

/// WETH → ETH via `withdraw(uint256)`. Returns the real tx hash.
/// Caller's WETH balance must be ≥ `args.amount` or the call reverts.
export async function withdrawWethToEth(deps: WrapDeps, args: WrapArgs): Promise<Hex> {
  const sim = await deps.publicClient.simulateContract({
    account: args.account,
    address: WETH9_BASE_SEPOLIA,
    abi: WETH9_ABI,
    functionName: 'withdraw',
    args: [args.amount],
  });
  return deps.walletClient.writeContract(sim.request);
}
