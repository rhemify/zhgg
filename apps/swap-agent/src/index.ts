/// `bun run apps/swap-agent <amount> <fromSym> <toSym>` — real swap on
/// Base Sepolia.
///
/// This file is the package barrel. Granular subpath consumers can still
/// import `swap-agent/uniswap-v3` or `swap-agent/wrap-fallback`; the
/// re-exports below give barrel consumers the same public surface.
///
/// Two routes:
///   - ETH ↔ WETH  → WETH9.deposit / WETH9.withdraw (no pool needed).
///   - else        → Uniswap V3 SwapRouter02.exactInputSingle, probing
///                   fee tiers in [500, 3000, 10000] order.
///
/// HARD RULES (from Slice E spec):
///   - NEVER fabricate a txHash. Real revert reasons bubble up.
///   - NEVER print BASE_SEPOLIA_PRIVATE_KEY. We read it from env, derive
///     the account, never log it.
///   - Symbols accepted: ETH, WETH, USDC. Anything else → `unsupported_symbol`.
///
/// The exported `executeSwap(...)` is what the TUI calls. The CLI
/// at the bottom is a convenience for ad-hoc shell testing.

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ensureErc20Allowance,
  findUniswapV3Pool,
  submitErc20OutEthExactInputSingle,
  submitEthInExactInputSingle,
  submitExactInputSingle,
  SWAP_ROUTER_02,
  type ExactInputSingleParams,
  type FeeTier,
} from './uniswap-v3.js';
import {
  depositEthToWeth,
  WETH9_BASE_SEPOLIA,
  withdrawWethToEth,
} from './wrap-fallback.js';

// ─── Token registry (Base Sepolia) ────────────────────────────────────────

export type SupportedSymbol = 'ETH' | 'WETH' | 'USDC';

export const SUPPORTED_SYMBOLS: ReadonlySet<SupportedSymbol> = new Set([
  'ETH',
  'WETH',
  'USDC',
]);

export const TOKEN_DECIMALS: Record<SupportedSymbol, number> = {
  ETH: 18,
  WETH: 18,
  USDC: 6,
};

/// Canonical Base Sepolia addresses. ETH is the native asset and has
/// no contract — we use the WETH9 address for routing decisions and
/// flag native-vs-wrapped at the call site.
export const TOKEN_ADDRESSES: Record<Exclude<SupportedSymbol, 'ETH'>, Address> = {
  WETH: WETH9_BASE_SEPOLIA,
  USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

// ─── Result / error types ─────────────────────────────────────────────────

export type SwapErrorKind =
  | 'unsupported_symbol'
  | 'invalid_amount'
  | 'no_pool'
  | 'execution_reverted'
  | 'env_missing';

export interface SwapError {
  kind: SwapErrorKind;
  reason: string;
}

export interface SwapSuccess {
  txHash: Hex;
  fromAmount: bigint;
  /// `0n` for the wrap fallback (no pool slippage applies). For Uniswap
  /// V3 paths this is the `amountOutMinimum` that was sent on-chain. We
  /// keep this slack on testnet because pool prices are noisy; a real
  /// production agent would compute a quote and apply bps slippage.
  toAmountMin: bigint;
  /// Discriminates which leg actually fired so audit logs / FLOW state
  /// can light up the right rail. `null` for the wrap fallback.
  poolFee: FeeTier | null;
  route: 'uniswap_v3' | 'weth9_deposit' | 'weth9_withdraw';
}

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface SwapClients {
  publicClient: PublicClient;
  walletClient: WalletClient;
  /// Full account object (LocalAccount from privateKeyToAccount). Must not
  /// be an Address string — viem coerces bare addresses to { type: "json-rpc" }
  /// which triggers eth_sendTransaction (rejected by public RPCs) instead of
  /// the correct sign-and-send eth_sendRawTransaction path.
  account: Account;
}

// ─── Public API: executeSwap ──────────────────────────────────────────────

/// Execute a swap from `fromSym` to `toSym` for `amount` (decimal string,
/// e.g. "0.001" or "5"). Returns a typed Result; on `ok: false` the
/// caller's TUI surfaces `error.kind` + `error.reason` verbatim.
///
/// All on-chain failures (insufficient balance, slippage, missing pool)
/// surface as `Result.Err` — never a fake txHash.
export async function executeSwap(
  clients: SwapClients,
  amount: string,
  fromSym: string,
  toSym: string,
): Promise<Result<SwapSuccess, SwapError>> {
  const fromU = fromSym.toUpperCase();
  const toU = toSym.toUpperCase();
  if (!SUPPORTED_SYMBOLS.has(fromU as SupportedSymbol)) {
    return err('unsupported_symbol', `from "${fromSym}" — supported: ETH, WETH, USDC`);
  }
  if (!SUPPORTED_SYMBOLS.has(toU as SupportedSymbol)) {
    return err('unsupported_symbol', `to "${toSym}" — supported: ETH, WETH, USDC`);
  }
  if (fromU === toU) {
    return err('invalid_amount', `from and to are the same symbol (${fromU})`);
  }

  const from = fromU as SupportedSymbol;
  const to = toU as SupportedSymbol;

  let amountIn: bigint;
  try {
    amountIn = parseUnits(amount, TOKEN_DECIMALS[from]);
  } catch (e) {
    return err('invalid_amount', `cannot parse "${amount}" — ${(e as Error).message}`);
  }
  if (amountIn <= 0n) {
    return err('invalid_amount', `amount must be > 0, got "${amount}"`);
  }

  // ── Wrap fallback paths (ETH ↔ WETH) — no Uniswap pool needed. ───────
  try {
    if (from === 'ETH' && to === 'WETH') {
      const txHash = await depositEthToWeth(
        { publicClient: clients.publicClient, walletClient: clients.walletClient },
        { account: clients.account, amount: amountIn },
      );
      return ok({
        txHash,
        fromAmount: amountIn,
        toAmountMin: 0n,
        poolFee: null,
        route: 'weth9_deposit',
      });
    }
    if (from === 'WETH' && to === 'ETH') {
      const txHash = await withdrawWethToEth(
        { publicClient: clients.publicClient, walletClient: clients.walletClient },
        { account: clients.account, amount: amountIn },
      );
      return ok({
        txHash,
        fromAmount: amountIn,
        toAmountMin: 0n,
        poolFee: null,
        route: 'weth9_withdraw',
      });
    }
  } catch (e) {
    return err('execution_reverted', (e as Error).message);
  }

  // ── Uniswap V3 path. ──────────────────────────────────────────────────
  const tokenIn: Address = from === 'ETH' ? WETH9_BASE_SEPOLIA : TOKEN_ADDRESSES[from];
  const tokenOut: Address = to === 'ETH' ? WETH9_BASE_SEPOLIA : TOKEN_ADDRESSES[to];

  const found = await findUniswapV3Pool(
    { publicClient: clients.publicClient },
    tokenIn,
    tokenOut,
  );
  if (!found) {
    return err('no_pool', `no Uniswap V3 pool for ${from}/${to} at any fee tier`);
  }

  // Permissive slippage for testnet — see uniswap-v3.ts header.
  const params: ExactInputSingleParams = {
    tokenIn,
    tokenOut,
    fee: found.fee,
    recipient: clients.account.address,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
    amountIn,
    amountOutMinimum: 0n,
    sqrtPriceLimitX96: 0n,
  };

  try {
    let txHash: Hex;
    if (from === 'ETH') {
      txHash = await submitEthInExactInputSingle(
        { publicClient: clients.publicClient, walletClient: clients.walletClient },
        { account: clients.account, params, value: amountIn },
      );
    } else if (to === 'ETH') {
      // Need ERC-20 allowance + multicall(swap, unwrapWETH9).
      await ensureErc20Allowance({
        publicClient: clients.publicClient,
        walletClient: clients.walletClient,
        account: clients.account,
        token: tokenIn,
        spender: SWAP_ROUTER_02,
        amount: amountIn,
      });
      txHash = await submitErc20OutEthExactInputSingle(
        { publicClient: clients.publicClient, walletClient: clients.walletClient },
        {
          account: clients.account,
          params,
          value: 0n,
          finalRecipient: clients.account.address,
        },
      );
    } else {
      // ERC-20 → ERC-20 (e.g. USDC → WETH).
      await ensureErc20Allowance({
        publicClient: clients.publicClient,
        walletClient: clients.walletClient,
        account: clients.account,
        token: tokenIn,
        spender: SWAP_ROUTER_02,
        amount: amountIn,
      });
      txHash = await submitExactInputSingle(
        { publicClient: clients.publicClient, walletClient: clients.walletClient },
        { account: clients.account, params, value: 0n },
      );
    }
    return ok({
      txHash,
      fromAmount: amountIn,
      toAmountMin: params.amountOutMinimum,
      poolFee: found.fee,
      route: 'uniswap_v3',
    });
  } catch (e) {
    return err('execution_reverted', (e as Error).message);
  }
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function err(kind: SwapErrorKind, reason: string): { ok: false; error: SwapError } {
  return { ok: false, error: { kind, reason } };
}

// ─── Client factory (env-driven) ──────────────────────────────────────────

export interface BuildClientsResult {
  ok: true;
  clients: SwapClients;
}

export interface BuildClientsError {
  ok: false;
  error: SwapError;
}

/// Build a `SwapClients` triple from BASE_SEPOLIA_RPC_URL +
/// BASE_SEPOLIA_PRIVATE_KEY. Used by both the CLI and the TUI to avoid
/// repeating the env-validation boilerplate.
export function buildClientsFromEnv(env: NodeJS.ProcessEnv = process.env): BuildClientsResult | BuildClientsError {
  const rpc = env.BASE_SEPOLIA_RPC_URL;
  const pk = env.BASE_SEPOLIA_PRIVATE_KEY;
  if (!rpc) {
    return { ok: false, error: { kind: 'env_missing', reason: 'BASE_SEPOLIA_RPC_URL is unset' } };
  }
  if (!pk) {
    return { ok: false, error: { kind: 'env_missing', reason: 'BASE_SEPOLIA_PRIVATE_KEY is unset' } };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    return { ok: false, error: { kind: 'env_missing', reason: 'BASE_SEPOLIA_PRIVATE_KEY is not a 32-byte 0x hex' } };
  }
  const account = privateKeyToAccount(pk as Hex);
  const transport = http(rpc);
  // Set chain: baseSepolia on both clients so viem uses eth_sendRawTransaction
  // (local signing) instead of eth_sendTransaction. Without chain, viem may
  // coerce the account to json-rpc type, causing the public RPC to reject with
  // -32602 (Invalid parameters) when it receives eth_sendTransaction.
  // Cast to the plain PublicClient / WalletClient interfaces: baseSepolia adds
  // OP-stack-specific transaction types that make the inferred type stricter
  // than what SwapClients.publicClient declares. All operations we perform
  // (readContract, simulateContract, waitForTransactionReceipt) are on the
  // shared interface, so the cast is safe.
  const publicClient = createPublicClient({ chain: baseSepolia, transport }) as PublicClient;
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport }) as WalletClient;
  return {
    ok: true,
    clients: { publicClient, walletClient, account },
  };
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [amount, fromSym, toSym] = process.argv.slice(2);
  if (!amount || !fromSym || !toSym) {
    console.error('usage: bun run apps/swap-agent <amount> <fromSym> <toSym>');
    console.error('example: bun run apps/swap-agent 0.0001 ETH WETH');
    process.exit(2);
  }
  const built = buildClientsFromEnv();
  if (!built.ok) {
    console.error(`env error: ${built.error.kind} — ${built.error.reason}`);
    process.exit(1);
  }
  const result = await executeSwap(built.clients, amount, fromSym, toSym);
  if (!result.ok) {
    console.error(`swap failed: ${result.error.kind} — ${result.error.reason}`);
    process.exit(1);
  }
  console.log(JSON.stringify(
    {
      txHash: result.value.txHash,
      route: result.value.route,
      poolFee: result.value.poolFee,
      fromAmount: result.value.fromAmount.toString(),
      toAmountMin: result.value.toAmountMin.toString(),
      basescan: `https://sepolia.basescan.org/tx/${result.value.txHash}`,
    },
    null,
    2,
  ));
}

if (import.meta.main) {
  void main();
}

// ─── Barrel re-exports (public API of the subpath modules) ────────────────

export {
  ensureErc20Allowance,
  FEE_TIERS,
  findUniswapV3Pool,
  submitErc20OutEthExactInputSingle,
  submitEthInExactInputSingle,
  submitExactInputSingle,
  SWAP_ROUTER_02,
  V3_FACTORY,
} from './uniswap-v3.js';
export type {
  EnsureAllowanceArgs,
  ExactInputSingleArgs,
  ExactInputSingleDeps,
  ExactInputSingleParams,
  FeeTier,
  FindPoolDeps,
} from './uniswap-v3.js';

export {
  depositEthToWeth,
  WETH9_BASE_SEPOLIA,
  withdrawWethToEth,
} from './wrap-fallback.js';
export type { WrapArgs, WrapDeps } from './wrap-fallback.js';
