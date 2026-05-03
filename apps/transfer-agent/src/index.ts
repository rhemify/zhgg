/// `bun run apps/transfer-agent <amount> <symbol> <recipient>` — real
/// on-chain transfer on Base Sepolia.
///
/// Two routes:
///   - ETH    → walletClient.sendTransaction({ to, value })
///   - WETH/USDC → IERC20.transfer(to, amount) on the token contract
///
/// HARD RULES:
///   - NEVER fabricate a txHash. Real reverts bubble up with viem's
///     decoded reason.
///   - NEVER print BASE_SEPOLIA_PRIVATE_KEY. Read from env, derive the
///     account, never log it.
///   - Symbols accepted: ETH, WETH, USDC. Anything else → `unsupported_symbol`.
///   - Recipient: 0x address (any) or *.eth name (resolved via mainnet ENS).
///
/// Exported `executeTransfer(...)` is the TUI entry point. The CLI at
/// the bottom is for ad-hoc shell testing — same rules apply.

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sendErc20Transfer } from './erc20.js';
import { sendNativeTransfer } from './native.js';
import { resolveRecipient } from './resolve-recipient.js';

// ─── Token registry (mirrors swap-agent) ──────────────────────────────────

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

/// Base Sepolia token contracts. ETH is native (no contract).
export const TOKEN_ADDRESSES: Record<Exclude<SupportedSymbol, 'ETH'>, Address> = {
  WETH: '0x4200000000000000000000000000000000000006',
  USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

// ─── Result / error types ─────────────────────────────────────────────────

export type TransferErrorKind =
  | 'unsupported_symbol'
  | 'invalid_amount'
  | 'invalid_recipient'
  | 'ens_not_configured'
  | 'ens_unresolved'
  | 'ens_lookup_failed'
  | 'execution_reverted'
  | 'env_missing';

export interface TransferError {
  kind: TransferErrorKind;
  reason: string;
}

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface TransferOk {
  txHash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
  resolvedRecipient: Address;
  recipientSource: 'address' | 'ens';
  symbol: SupportedSymbol;
  amount: string;
  amountAtomic: bigint;
}

// ─── Public API ───────────────────────────────────────────────────────────

export interface ExecuteTransferOpts {
  /// Decimal-string amount (e.g. "0.5" for 0.5 USDC). Converted to
  /// atomic units via parseUnits + TOKEN_DECIMALS[symbol].
  amount: string;
  /// One of ETH / WETH / USDC.
  symbol: string;
  /// Raw recipient — 0x address or *.eth name.
  recipient: string;
  /// Pre-built clients. Account is inferred from walletClient.
  basePub: PublicClient;
  baseWallet: WalletClient;
  /// Override mainnet RPC for ENS resolution. Defaults to env or public.
  ensRpcUrl?: string;
}

export async function executeTransfer(
  opts: ExecuteTransferOpts,
): Promise<Result<TransferOk, TransferError>> {
  const sym = opts.symbol.toUpperCase();
  if (!SUPPORTED_SYMBOLS.has(sym as SupportedSymbol)) {
    return {
      ok: false,
      error: {
        kind: 'unsupported_symbol',
        reason: `${opts.symbol} not in supported set (ETH, WETH, USDC)`,
      },
    };
  }
  const symbol = sym as SupportedSymbol;

  if (!/^\d+(\.\d+)?$/.test(opts.amount)) {
    return {
      ok: false,
      error: {
        kind: 'invalid_amount',
        reason: `amount "${opts.amount}" — expected decimal (e.g. 0.5, 100)`,
      },
    };
  }
  let amountAtomic: bigint;
  try {
    amountAtomic = parseUnits(opts.amount, TOKEN_DECIMALS[symbol]);
  } catch (e) {
    return {
      ok: false,
      error: {
        kind: 'invalid_amount',
        reason: `parseUnits failed: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }
  if (amountAtomic <= 0n) {
    return {
      ok: false,
      error: { kind: 'invalid_amount', reason: 'amount must be > 0' },
    };
  }

  const resolved = await resolveRecipient(opts.recipient, { ensRpcUrl: opts.ensRpcUrl });
  if (!resolved.ok) {
    return { ok: false, error: { kind: resolved.error.kind, reason: resolved.error.reason } };
  }

  const sender = opts.baseWallet.account?.address;
  if (!sender) {
    return {
      ok: false,
      error: {
        kind: 'env_missing',
        reason: 'walletClient has no account configured (BASE_SEPOLIA_PRIVATE_KEY missing?)',
      },
    };
  }

  try {
    if (symbol === 'ETH') {
      const r = await sendNativeTransfer(opts.basePub, opts.baseWallet, {
        from: sender,
        to: resolved.address,
        valueWei: amountAtomic,
      });
      return {
        ok: true,
        value: {
          txHash: r.txHash,
          blockNumber: r.blockNumber,
          gasUsed: r.gasUsed,
          resolvedRecipient: resolved.address,
          recipientSource: resolved.source,
          symbol,
          amount: opts.amount,
          amountAtomic,
        },
      };
    }
    const tokenAddr = TOKEN_ADDRESSES[symbol];
    const r = await sendErc20Transfer(opts.basePub, opts.baseWallet, {
      token: tokenAddr,
      from: sender,
      to: resolved.address,
      amount: amountAtomic,
    });
    return {
      ok: true,
      value: {
        txHash: r.txHash,
        blockNumber: r.blockNumber,
        gasUsed: r.gasUsed,
        resolvedRecipient: resolved.address,
        recipientSource: resolved.source,
        symbol,
        amount: opts.amount,
        amountAtomic,
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: {
        kind: 'execution_reverted',
        reason: e instanceof Error ? e.message : String(e),
      },
    };
  }
}

// ─── CLI entry point ──────────────────────────────────────────────────────

async function cli(): Promise<void> {
  const [, , amount, symbol, recipient] = process.argv;
  if (!amount || !symbol || !recipient) {
    console.error(
      'usage: bun run apps/transfer-agent <amount> <ETH|WETH|USDC> <recipient>',
    );
    console.error('examples:');
    console.error('  bun run apps/transfer-agent 0.0001 ETH 0xAbc...123');
    console.error('  bun run apps/transfer-agent 1 USDC vitalik.eth');
    process.exit(2);
  }
  const pkRaw = process.env.BASE_SEPOLIA_PRIVATE_KEY;
  const rpc = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';
  if (!pkRaw || !/^0x[0-9a-fA-F]{64}$/.test(pkRaw)) {
    console.error('BASE_SEPOLIA_PRIVATE_KEY missing or malformed');
    process.exit(2);
  }
  const account = privateKeyToAccount(pkRaw as Hex);
  const transport = http(rpc);
  const basePub = createPublicClient({ transport });
  const baseWallet = createWalletClient({ account, transport });

  const r = await executeTransfer({
    amount,
    symbol,
    recipient,
    basePub,
    baseWallet,
  });
  if (!r.ok) {
    console.error(`transfer failed (${r.error.kind}): ${r.error.reason}`);
    process.exit(1);
  }
  console.log(`✓ ${r.value.amount} ${r.value.symbol} → ${r.value.resolvedRecipient}`);
  console.log(`  tx:    ${r.value.txHash}`);
  console.log(`  block: ${r.value.blockNumber}`);
  console.log(`  gas:   ${r.value.gasUsed}`);
}

if (import.meta.main) {
  cli().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}

// ─── Barrel re-exports (public API of the subpath modules) ────────────────
//
// Granular consumers can keep importing `transfer-agent/erc20`,
// `transfer-agent/native`, or `transfer-agent/resolve-recipient`. The
// re-exports below let barrel consumers reach the same surface from the
// package root.

export { sendErc20Transfer } from './erc20.js';
export type { Erc20TransferRequest, Erc20TransferResult } from './erc20.js';

export { sendNativeTransfer } from './native.js';
export type { NativeTransferRequest, NativeTransferResult } from './native.js';

export { resolveRecipient } from './resolve-recipient.js';
export type { ResolveError, ResolveOptions, ResolveResult } from './resolve-recipient.js';
