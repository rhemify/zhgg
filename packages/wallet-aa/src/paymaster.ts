/// ERC-20 Paymaster client for Pimlico v0.7.
///
/// Encodes the `paymasterAndData` field that lets a UserOp be sponsored
/// in USDC instead of ETH. The agent only ever holds USDC; the paymaster
/// pays gas to the EntryPoint and debits the agent's USDC inside the
/// paymaster's `postOp`.
///
/// Real RPC: `pimlico_getTokenQuotes` + `pm_getPaymasterStubData` +
/// `pm_getPaymasterData`. The first lets us check the USDC/ETH price
/// the paymaster will charge; the latter two return the paymaster bytes
/// to splice into the UserOp's paymasterAndData field.

import {
  concatHex,
  numberToHex,
  pad,
  type Address,
  type Hex,
} from 'viem';
import {
  rpcCall,
  type BundlerOptions,
  type BundlerOutcome,
  type FetchLike,
  type PackedUserOperation,
} from './userop.js';

export interface PaymasterTokenQuote {
  /// USDC decimals scaled price for 1 unit of native gas token.
  exchangeRate: Hex;
  /// Wei equivalent the user is charged in USDC per gas unit.
  priceMarkup: Hex;
}

/// Quote the paymaster's USDC price for the user's chain. Returns
/// per-token quotes the bundler is willing to accept right now.
export async function pimlicoGetTokenQuotes(
  args: { tokens: readonly Address[]; chainId: number },
  opts: BundlerOptions
): Promise<BundlerOutcome<Record<string, PaymasterTokenQuote>>> {
  return rpcCall<Record<string, PaymasterTokenQuote>>(
    opts,
    'pimlico_getTokenQuotes',
    [args.tokens, numberToHex(BigInt(args.chainId))]
  );
}

export interface PaymasterStubResult {
  paymaster: Address;
  paymasterData: Hex;
  paymasterVerificationGasLimit: Hex;
  paymasterPostOpGasLimit: Hex;
  isFinal?: boolean;
}

/// Estimate the paymaster bytes for gas estimation. Pimlico returns a
/// stub that's gas-equivalent to the real paymasterData but uses
/// throwaway signatures; safe for `eth_estimateUserOperationGas`.
export async function pmGetPaymasterStubData(
  op: Omit<PackedUserOperation, 'signature' | 'paymasterAndData'>,
  entryPoint: Address,
  context: { token: Address },
  opts: BundlerOptions
): Promise<BundlerOutcome<PaymasterStubResult>> {
  return rpcCall<PaymasterStubResult>(opts, 'pm_getPaymasterStubData', [
    {
      sender: op.sender,
      nonce: numberToHex(op.nonce),
      initCode: op.initCode,
      callData: op.callData,
      accountGasLimits: op.accountGasLimits,
      preVerificationGas: numberToHex(op.preVerificationGas),
      gasFees: op.gasFees,
    },
    entryPoint,
    context,
  ]);
}

/// Final paymasterAndData with real signature. Call after gas estimates
/// are locked in. The returned bytes are valid for the next ~30s.
export async function pmGetPaymasterData(
  op: Omit<PackedUserOperation, 'signature' | 'paymasterAndData'>,
  entryPoint: Address,
  context: { token: Address },
  opts: BundlerOptions
): Promise<BundlerOutcome<PaymasterStubResult>> {
  return rpcCall<PaymasterStubResult>(opts, 'pm_getPaymasterData', [
    {
      sender: op.sender,
      nonce: numberToHex(op.nonce),
      initCode: op.initCode,
      callData: op.callData,
      accountGasLimits: op.accountGasLimits,
      preVerificationGas: numberToHex(op.preVerificationGas),
      gasFees: op.gasFees,
    },
    entryPoint,
    context,
  ]);
}

/// Encode `paymasterAndData` from a stub/data result. v0.7 layout:
///   paymaster (20) || verifGasLimit (16) || postOpGasLimit (16) || data
export function encodePaymasterAndData(stub: PaymasterStubResult): Hex {
  const verifPacked = pad(stub.paymasterVerificationGasLimit, { size: 16 });
  const postPacked = pad(stub.paymasterPostOpGasLimit, { size: 16 });
  return concatHex([stub.paymaster, verifPacked, postPacked, stub.paymasterData]);
}

/// USDC contract on Base Sepolia (Circle official mock).
export const USDC_BASE_SEPOLIA: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

export type { FetchLike };
