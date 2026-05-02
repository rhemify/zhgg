/// Native ETH transfer on Base Sepolia.
///
/// One call: `walletClient.sendTransaction({ to, value })`. Real on-chain
/// tx, no synthetic fallback. Reverts (rare for native transfers — only
/// if `to` is a contract whose `receive`/`fallback` reverts) bubble up
/// with viem's decoded reason.

import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';

export interface NativeTransferRequest {
  /// Sender — must match the wallet client's account.
  from: Address;
  /// Recipient — already-validated EOA or contract address.
  to: Address;
  /// Atomic units (wei).
  valueWei: bigint;
}

export interface NativeTransferResult {
  txHash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
}

export async function sendNativeTransfer(
  basePub: PublicClient,
  baseWallet: WalletClient,
  req: NativeTransferRequest,
): Promise<NativeTransferResult> {
  // Pre-flight: does the sender have enough balance for value + worst-case
  // gas? If not, fail loud BEFORE submitting so the operator sees a
  // helpful error instead of "insufficient funds" mid-broadcast.
  const balance = await basePub.getBalance({ address: req.from });
  // Estimate gas separately so we can enrich the error message. Native
  // transfers to EOAs are 21k; transfers to contracts can be higher.
  const gasEstimate = await basePub.estimateGas({
    account: req.from,
    to: req.to,
    value: req.valueWei,
  });
  const gasPrice = await basePub.getGasPrice();
  const gasCost = gasEstimate * gasPrice;
  if (balance < req.valueWei + gasCost) {
    throw new Error(
      `insufficient ETH: have ${balance} wei, need ${req.valueWei + gasCost} wei (${req.valueWei} value + ${gasCost} gas)`,
    );
  }

  // sendTransaction. Account inferred from walletClient.
  const txHash = await baseWallet.sendTransaction({
    account: req.from,
    chain: null,
    to: req.to,
    value: req.valueWei,
  });

  const receipt = await basePub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status === 'reverted') {
    throw new Error('native transfer reverted on-chain');
  }
  return {
    txHash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
  };
}
