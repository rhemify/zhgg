/// ERC-20 transfer on Base Sepolia.
///
/// Direct `IERC20.transfer(to, amount)` from the sender's wallet — no
/// approve/transferFrom dance because the sender IS the holder. Works
/// for USDC, WETH, and any other standard ERC-20.
///
/// Reverts surface verbatim through viem's `BaseError` decoder so the
/// TUI can show the real reason ("transfer amount exceeds balance" etc).

import {
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';

const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

export interface Erc20TransferRequest {
  /// Token contract.
  token: Address;
  /// Sender (must match wallet client's account).
  from: Address;
  /// Recipient.
  to: Address;
  /// Atomic units (already scaled by token decimals).
  amount: bigint;
}

export interface Erc20TransferResult {
  txHash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
}

export async function sendErc20Transfer(
  basePub: PublicClient,
  baseWallet: WalletClient,
  req: Erc20TransferRequest,
): Promise<Erc20TransferResult> {
  // Pre-flight: check balance. Most common failure mode — surface it
  // before broadcasting a doomed tx.
  const balance = await basePub.readContract({
    address: req.token,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [req.from],
  });
  if (balance < req.amount) {
    throw new Error(
      `insufficient ERC-20 balance: have ${balance}, need ${req.amount} (token=${req.token})`,
    );
  }

  // Simulate first so reverts come back as decoded viem errors with the
  // contract's revert string included.
  const sim = await basePub.simulateContract({
    account: req.from,
    address: req.token,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [req.to, req.amount],
  });

  const txHash = await baseWallet.writeContract(sim.request);
  const receipt = await basePub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status === 'reverted') {
    throw new Error('ERC-20 transfer reverted on-chain');
  }
  return {
    txHash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
  };
}
