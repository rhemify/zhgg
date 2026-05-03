/// Uniswap V3 swap path on Base Sepolia.
///
/// Implements `exactInputSingle` against SwapRouter02 at the canonical
/// Base Sepolia address. The high-level flow is:
///   1. probe Factory.getPool(tokenIn, tokenOut, fee) at fee tiers
///      [500, 3000, 10000] in that order (most-liquid first based on
///      our probe — see slice E commit message).
///   2. if all pools are zero → throw `no_pool` (no synthetic tx).
///   3. for ERC-20 input, ensure SwapRouter02 has an allowance ≥ amountIn
///      and bump it via `approve` if not.
///   4. simulate `exactInputSingle`, then `writeContract` and wait for the
///      receipt. If the simulation reverts, the real revert reason
///      bubbles up — viem decodes Solidity Error(string) automatically.
///
/// We deliberately keep the slippage policy permissive (`amountOutMinimum
/// = 0`) for this slice — Base Sepolia testnet pool prices are noisy and
/// the goal is to prove the loop end-to-end, not protect production
/// dollars. A real production path would compute a quote first and apply
/// a basis-points slippage tolerance. Documented here so reviewers don't
/// assume the missing slippage is an oversight.

import {
  encodeFunctionData,
  erc20Abi,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';

// ─── Canonical Base Sepolia addresses ─────────────────────────────────────

/// Uniswap V3 SwapRouter02 (canonical, Base Sepolia).
/// https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments
export const SWAP_ROUTER_02: Address = '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4';

/// Uniswap V3 Factory (canonical, Base Sepolia).
export const V3_FACTORY: Address = '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24';

/// Fee tiers, in order of preference. 500 (0.05%) carries the most
/// liquidity on Base Sepolia per our 2026-05-02 probe; 3000 (0.3%) is
/// the fallback if 500 is empty for the pair.
export const FEE_TIERS = [500, 3000, 10000] as const;
export type FeeTier = (typeof FEE_TIERS)[number];

// ─── ABIs ─────────────────────────────────────────────────────────────────

const FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const;

const SWAP_ROUTER_ABI = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'multicall',
    stateMutability: 'payable',
    inputs: [{ name: 'data', type: 'bytes[]' }],
    outputs: [{ name: 'results', type: 'bytes[]' }],
  },
  {
    type: 'function',
    name: 'refundETH',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'unwrapWETH9',
    stateMutability: 'payable',
    inputs: [
      { name: 'amountMinimum', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [],
  },
] as const;

const ZERO_ADDR: Address = '0x0000000000000000000000000000000000000000';

// ─── Public types ─────────────────────────────────────────────────────────

export interface ExactInputSingleParams {
  tokenIn: Address;
  tokenOut: Address;
  fee: FeeTier;
  recipient: Address;
  deadline: bigint;
  amountIn: bigint;
  amountOutMinimum: bigint;
  sqrtPriceLimitX96: bigint;
}

export interface FindPoolDeps {
  publicClient: PublicClient;
}

/// Probe the V3 factory for a USDC/WETH-style pair at every fee tier in
/// `FEE_TIERS`. Returns the first non-zero pool address along with its
/// fee tier, or `null` if none exist.
export async function findUniswapV3Pool(
  deps: FindPoolDeps,
  tokenA: Address,
  tokenB: Address,
): Promise<{ pool: Address; fee: FeeTier } | null> {
  for (const fee of FEE_TIERS) {
    const pool = await deps.publicClient.readContract({
      address: V3_FACTORY,
      abi: FACTORY_ABI,
      functionName: 'getPool',
      args: [tokenA, tokenB, fee],
    });
    if (pool !== ZERO_ADDR) return { pool, fee };
  }
  return null;
}

// ─── Approval helper ──────────────────────────────────────────────────────

export interface EnsureAllowanceArgs {
  publicClient: PublicClient;
  walletClient: WalletClient;
  /// Full account object (LocalAccount from privateKeyToAccount). Must not
  /// be an Address string — passing an Address causes viem to coerce it to
  /// a json-rpc account, which attempts eth_sendTransaction (not supported
  /// on public RPCs) instead of signing locally via eth_sendRawTransaction.
  account: Account;
  token: Address;
  spender: Address;
  amount: bigint;
}

/// Ensure `spender` has at least `amount` allowance from `account` on
/// `token`. Returns the approval tx hash if one was sent, else `null`.
/// Uses MaxUint256 to keep gas cost amortised across re-runs.
export async function ensureErc20Allowance(args: EnsureAllowanceArgs): Promise<Hex | null> {
  const current = await args.publicClient.readContract({
    address: args.token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [args.account.address, args.spender],
  });
  if (current >= args.amount) return null;
  const max = (1n << 256n) - 1n;
  const sim = await args.publicClient.simulateContract({
    account: args.account,
    address: args.token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [args.spender, max],
  });
  const txHash = await args.walletClient.writeContract(sim.request);
  await args.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

// ─── exactInputSingle ─────────────────────────────────────────────────────

export interface ExactInputSingleDeps {
  publicClient: PublicClient;
  walletClient: WalletClient;
}

export interface ExactInputSingleArgs {
  /// Full account object (LocalAccount from privateKeyToAccount). Must not
  /// be an Address string — viem coerces bare addresses to json-rpc type,
  /// which triggers eth_sendTransaction (rejected by public RPCs) instead
  /// of the correct eth_sendRawTransaction path.
  account: Account;
  params: ExactInputSingleParams;
  /// When `tokenIn` is the zero-address sentinel for native ETH, the
  /// caller passes the value to send with the call. SwapRouter02 wraps
  /// it via the multicall path. For ERC-20 inputs this is `0n`.
  value: bigint;
}

/// Submit `exactInputSingle` to SwapRouter02. Returns the real tx hash.
/// If simulation reverts, the underlying viem error (with Solidity
/// reason) is re-thrown — caller must NOT swallow it.
export async function submitExactInputSingle(
  deps: ExactInputSingleDeps,
  args: ExactInputSingleArgs,
): Promise<Hex> {
  const sim = await deps.publicClient.simulateContract({
    account: args.account,
    address: SWAP_ROUTER_02,
    abi: SWAP_ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [args.params],
    value: args.value,
  });
  return deps.walletClient.writeContract(sim.request);
}

/// Variant: ETH → ERC-20 via SwapRouter02.multicall([exactInputSingle, refundETH]).
/// SwapRouter02 wraps msg.value to WETH, performs the swap, then
/// `refundETH` returns any leftover ETH dust to the caller.
export async function submitEthInExactInputSingle(
  deps: ExactInputSingleDeps,
  args: ExactInputSingleArgs,
): Promise<Hex> {
  const swapData = encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [args.params],
  });
  const refundData = encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: 'refundETH',
    args: [],
  });
  const sim = await deps.publicClient.simulateContract({
    account: args.account,
    address: SWAP_ROUTER_02,
    abi: SWAP_ROUTER_ABI,
    functionName: 'multicall',
    args: [[swapData, refundData]],
    value: args.value,
  });
  return deps.walletClient.writeContract(sim.request);
}

/// Variant: ERC-20 → ETH via SwapRouter02.multicall([exactInputSingle, unwrapWETH9]).
/// `recipient` of the inner exactInputSingle MUST be the router itself
/// (so `unwrapWETH9` can sweep the WETH balance), then unwrap forwards
/// native ETH to the user. We reset `params.recipient` to the router
/// here so callers don't need to think about it.
export async function submitErc20OutEthExactInputSingle(
  deps: ExactInputSingleDeps,
  args: ExactInputSingleArgs & { finalRecipient: Address },
): Promise<Hex> {
  const innerParams: ExactInputSingleParams = {
    ...args.params,
    recipient: SWAP_ROUTER_02,
  };
  const swapData = encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [innerParams],
  });
  const unwrapData = encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: 'unwrapWETH9',
    args: [args.params.amountOutMinimum, args.finalRecipient],
  });
  const sim = await deps.publicClient.simulateContract({
    account: args.account,
    address: SWAP_ROUTER_02,
    abi: SWAP_ROUTER_ABI,
    functionName: 'multicall',
    args: [[swapData, unwrapData]],
    value: args.value,
  });
  return deps.walletClient.writeContract(sim.request);
}
