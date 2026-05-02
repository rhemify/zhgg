/// ERC-4626 yield-vault intents (Slice K) — real on-chain dispatchers.
///
/// Two operations against the user's AgentReceiverWallet on Base Sepolia:
///
///   park <amount> <USDC|WETH>   (default tokenId=1)
///   park <tokenId> <amount> <USDC|WETH>
///     - resolve receiver via AgentReceiverWalletFactory.statusOf(tokenId)
///     - refuse if not deployed (predict + cast send unblock hint)
///     - read receiver.yieldVault() — refuse if not wired
///     - read receiver.yieldAsset() + that token's balanceOf(receiver)
///     - refuse if idle balance == 0 (transfer-to-receiver unblock hint)
///     - simulateContract + writeContract receiver.parkIdle()
///     - waitForTransactionReceipt; emit park.confirmed + post-tx
///       share balance read so the operator sees the position
///
///   unpark <amount> <USDC|WETH>   (default tokenId=1)
///   unpark <tokenId> <amount> <USDC|WETH>
///     - same resolution + vault-wired checks as park
///     - additional: caller must be the iNFT owner (withdrawIdle is
///       owner-only on the wallet); we check before sending the tx
///     - vault.balanceOf(receiver) > 0 + previewRedeem(allShares) >=
///       requestedAmount; refuse with the available cap if short
///     - simulateContract + writeContract receiver.withdrawIdle(amount)
///     - waitForTransactionReceipt; emit unpark.confirmed with the
///       precise shares-burned (sharesBefore - sharesAfter) and
///       assets-out (= the requested amount, exact by ERC-4626 contract)
///
/// Required env (refused with a precise reason if missing):
///   RECEIVER_FACTORY_ADDRESS — AgentReceiverWalletFactory on Base Sepolia
///   YIELD_VAULT_ADDRESS      — MockERC4626 (deploy via
///     forge script script/DeployYieldVault.s.sol --rpc-url
///     $BASE_SEPOLIA_RPC_URL --broadcast)
///
/// Reverts bubble verbatim — the contract's NotOwner / NothingToSplit /
/// VaultAssetMismatch errors are surfaced as the audit row's event text.

import {
  parseAbi,
  parseUnits,
  formatUnits,
  type Address,
  type Account,
  type PublicClient,
  type WalletClient,
} from 'viem';

// ─── ABIs ───────────────────────────────────────────────────────────────
//
// Minimal-surface ABIs verified against
// contracts/src/AgentReceiverWalletFactory.sol +
// contracts/src/AgentReceiverWallet.sol. We expose only the functions /
// errors we actually call.

const RECEIVER_FACTORY_ABI = parseAbi([
  'function predict(uint256 tokenId) view returns (address)',
  'function statusOf(uint256 tokenId) view returns (address addr, bool deployed)',
]);

const RECEIVER_WALLET_ABI = parseAbi([
  'function parkIdle()',
  'function withdrawIdle(uint256 assets)',
  'function yieldVault() view returns (address)',
  'function yieldAsset() view returns (address)',
  'function owner() view returns (address)',
]);

const ERC20_BALANCE_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
]);

const ERC4626_READ_ABI = parseAbi([
  'function asset() view returns (address)',
  'function balanceOf(address account) view returns (uint256)',
  'function previewRedeem(uint256 shares) view returns (uint256)',
]);

/// Decimals lookup for the supported park symbols. USDC on Base Sepolia
/// is 6 decimals; WETH is 18. Hardcoded to avoid an extra `decimals()`
/// read per dispatch — these never change for the configured tokens.
export const PARK_DECIMALS: Record<'USDC' | 'WETH', number> = { USDC: 6, WETH: 18 };

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

export type YieldRow = {
  agent: string;
  event: string;
  ok: 'ok' | 'err' | 'info';
};

export interface ParkInput {
  symbol: 'USDC' | 'WETH';
  amount: string;
  tokenId: bigint;
  factory: Address;
  yieldVaultEnv: Address;
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
}

export type ParkResult =
  | { ok: false; rows: YieldRow[] }
  | {
      ok: true;
      rows: YieldRow[];
      txHash: `0x${string}`;
      receiver: Address;
      blockNumber: bigint;
      gasUsed: bigint;
      sharesAfter: bigint;
    };

export async function executePark(input: ParkInput): Promise<ParkResult> {
  const rows: YieldRow[] = [];
  const { publicClient, walletClient, account, factory, yieldVaultEnv, tokenId, symbol, amount } = input;

  // 1. Resolve receiver wallet from factory.
  const [receiver, deployed] = await publicClient.readContract({
    address: factory,
    abi: RECEIVER_FACTORY_ABI,
    functionName: 'statusOf',
    args: [tokenId],
  });
  if (!deployed) {
    rows.push({
      agent: 'yield',
      event: `park blocked: receiver wallet for #${tokenId} not deployed — predicted ${receiver}`,
      ok: 'err',
    });
    rows.push({
      agent: 'yield',
      event: `  unblock: cast send ${factory} "deploy(uint256)" ${tokenId} --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $BASE_SEPOLIA_PRIVATE_KEY`,
      ok: 'info',
    });
    return { ok: false, rows };
  }
  rows.push({ agent: 'yield', event: `park.receiver #${tokenId} → ${receiver}`, ok: 'info' });

  // 2. Verify the wallet has the configured vault wired. parkIdle() is
  //    a no-op when yieldVault==address(0); rather than dispatch a
  //    successful tx that does nothing, refuse loudly.
  const wired = (await publicClient.readContract({
    address: receiver,
    abi: RECEIVER_WALLET_ABI,
    functionName: 'yieldVault',
  })) as Address;
  if (wired.toLowerCase() === ZERO_ADDR) {
    rows.push({ agent: 'yield', event: `park blocked: receiver ${receiver} has no yieldVault wired`, ok: 'err' });
    rows.push({
      agent: 'yield',
      event: `  unblock: from iNFT owner — cast send ${receiver} "setYieldVault(address)" ${yieldVaultEnv} --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $BASE_SEPOLIA_PRIVATE_KEY`,
      ok: 'info',
    });
    return { ok: false, rows };
  }
  if (wired.toLowerCase() !== yieldVaultEnv.toLowerCase()) {
    rows.push({
      agent: 'yield',
      event: `park warn: receiver wired vault ${wired} differs from env YIELD_VAULT_ADDRESS ${yieldVaultEnv} — proceeding with the wired one`,
      ok: 'info',
    });
  }

  // 3. Read receiver's idle balance of `yieldAsset`. Compare to the
  //    requested amount so the operator gets a clear "wallet is empty"
  //    error instead of a silent no-op tx.
  const yieldAssetAddr = (await publicClient.readContract({
    address: receiver,
    abi: RECEIVER_WALLET_ABI,
    functionName: 'yieldAsset',
  })) as Address;
  const decimals = PARK_DECIMALS[symbol];
  const requestedAtomic = parseUnits(amount, decimals);
  const idle = (await publicClient.readContract({
    address: yieldAssetAddr,
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: [receiver],
  })) as bigint;

  if (idle === 0n) {
    rows.push({
      agent: 'yield',
      event: `park blocked: receiver ${receiver} has 0 ${symbol} idle — fund it first`,
      ok: 'err',
    });
    rows.push({
      agent: 'yield',
      event: `  unblock: transfer ${amount} ${symbol} ${receiver}`,
      ok: 'info',
    });
    return { ok: false, rows };
  }
  if (idle < requestedAtomic) {
    rows.push({
      agent: 'yield',
      event: `park warn: receiver idle=${formatUnits(idle, decimals)} ${symbol} < requested ${amount} — parking ${formatUnits(idle, decimals)} (parkIdle deposits FULL idle)`,
      ok: 'info',
    });
  } else {
    rows.push({
      agent: 'yield',
      event: `park.precheck idle=${formatUnits(idle, decimals)} ${symbol} (parkIdle deposits FULL idle)`,
      ok: 'info',
    });
  }

  // 4. parkIdle is permissionless. Sim first to surface a pre-flight
  //    revert cleanly, then submit the real tx.
  const sim = await publicClient.simulateContract({
    account,
    address: receiver,
    abi: RECEIVER_WALLET_ABI,
    functionName: 'parkIdle',
  });
  rows.push({ agent: 'yield', event: 'park.tx submitting parkIdle()…', ok: 'info' });
  const txHash = await walletClient.writeContract(sim.request);
  const rcpt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  rows.push({
    agent: 'yield',
    event: `park.confirmed tx=${txHash} status=${rcpt.status} blk=${rcpt.blockNumber} gas=${rcpt.gasUsed}`,
    ok: rcpt.status === 'success' ? 'ok' : 'err',
  });

  // 5. Post-tx: read share balance so the operator sees the actual
  //    ERC-4626 position the receiver is now holding.
  let sharesAfter = 0n;
  try {
    sharesAfter = (await publicClient.readContract({
      address: wired,
      abi: ERC4626_READ_ABI,
      functionName: 'balanceOf',
      args: [receiver],
    })) as bigint;
    rows.push({ agent: 'yield', event: `park.shares-held ${sharesAfter.toString()} (vault ${wired})`, ok: 'ok' });
  } catch (e) {
    rows.push({
      agent: 'yield',
      event: `park.shares-read failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160),
      ok: 'err',
    });
  }

  return {
    ok: true,
    rows,
    txHash,
    receiver,
    blockNumber: rcpt.blockNumber,
    gasUsed: rcpt.gasUsed,
    sharesAfter,
  };
}

export interface UnparkInput {
  symbol: 'USDC' | 'WETH';
  amount: string;
  tokenId: bigint;
  factory: Address;
  yieldVaultEnv: Address;
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
}

export type UnparkResult =
  | { ok: false; rows: YieldRow[] }
  | {
      ok: true;
      rows: YieldRow[];
      txHash: `0x${string}`;
      receiver: Address;
      blockNumber: bigint;
      gasUsed: bigint;
      sharesBurned: bigint;
      assetsOut: bigint;
    };

export async function executeUnpark(input: UnparkInput): Promise<UnparkResult> {
  const rows: YieldRow[] = [];
  const { publicClient, walletClient, account, factory, yieldVaultEnv: _yieldVaultEnv, tokenId, symbol, amount } = input;

  // 1. Resolve receiver from factory.
  const [receiver, deployed] = await publicClient.readContract({
    address: factory,
    abi: RECEIVER_FACTORY_ABI,
    functionName: 'statusOf',
    args: [tokenId],
  });
  if (!deployed) {
    rows.push({
      agent: 'yield',
      event: `unpark blocked: receiver wallet for #${tokenId} not deployed — predicted ${receiver}`,
      ok: 'err',
    });
    return { ok: false, rows };
  }
  rows.push({ agent: 'yield', event: `unpark.receiver #${tokenId} → ${receiver}`, ok: 'info' });

  // 2. withdrawIdle is OWNER-only — refuse early if the operator's
  //    wallet isn't the iNFT owner. Saves a tx + a confusing on-chain
  //    revert.
  const ownerNow = (await publicClient.readContract({
    address: receiver,
    abi: RECEIVER_WALLET_ABI,
    functionName: 'owner',
  })) as Address;
  if (ownerNow.toLowerCase() !== account.address.toLowerCase()) {
    rows.push({
      agent: 'yield',
      event: `unpark blocked: caller ${account.address} is not iNFT #${tokenId} owner (${ownerNow})`,
      ok: 'err',
    });
    return { ok: false, rows };
  }

  // 3. Vault must be wired.
  const wired = (await publicClient.readContract({
    address: receiver,
    abi: RECEIVER_WALLET_ABI,
    functionName: 'yieldVault',
  })) as Address;
  if (wired.toLowerCase() === ZERO_ADDR) {
    rows.push({ agent: 'yield', event: `unpark blocked: receiver ${receiver} has no yieldVault wired`, ok: 'err' });
    return { ok: false, rows };
  }

  // 4. Pre-check: receiver must hold enough shares to back the
  //    requested withdraw. Read shares + previewRedeem(all-shares) to
  //    estimate available assets. If insufficient, refuse loudly so
  //    the operator sees the cap before the on-chain revert.
  const decimals = PARK_DECIMALS[symbol];
  const requestedAtomic = parseUnits(amount, decimals);
  const sharesHeld = (await publicClient.readContract({
    address: wired,
    abi: ERC4626_READ_ABI,
    functionName: 'balanceOf',
    args: [receiver],
  })) as bigint;
  if (sharesHeld === 0n) {
    rows.push({
      agent: 'yield',
      event: `unpark blocked: receiver ${receiver} holds 0 vault shares — nothing to unpark`,
      ok: 'err',
    });
    return { ok: false, rows };
  }
  const availableAssets = (await publicClient.readContract({
    address: wired,
    abi: ERC4626_READ_ABI,
    functionName: 'previewRedeem',
    args: [sharesHeld],
  })) as bigint;
  if (availableAssets < requestedAtomic) {
    rows.push({
      agent: 'yield',
      event: `unpark blocked: requested ${amount} ${symbol} exceeds available ${formatUnits(availableAssets, decimals)} ${symbol}`,
      ok: 'err',
    });
    return { ok: false, rows };
  }
  rows.push({
    agent: 'yield',
    event: `unpark.precheck shares=${sharesHeld.toString()} preview=${formatUnits(availableAssets, decimals)} ${symbol}`,
    ok: 'info',
  });

  // 5. Submit withdrawIdle(amount).
  const sim = await publicClient.simulateContract({
    account,
    address: receiver,
    abi: RECEIVER_WALLET_ABI,
    functionName: 'withdrawIdle',
    args: [requestedAtomic],
  });
  rows.push({ agent: 'yield', event: 'unpark.tx submitting withdrawIdle()…', ok: 'info' });
  const txHash = await walletClient.writeContract(sim.request);
  const rcpt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  // 6. Compute shares burned by reading post-tx share balance. The
  //    assets-out is exactly the requested amount (ERC-4626 contract
  //    guarantees that on a successful withdraw).
  let sharesBurned = 0n;
  try {
    const sharesAfter = (await publicClient.readContract({
      address: wired,
      abi: ERC4626_READ_ABI,
      functionName: 'balanceOf',
      args: [receiver],
    })) as bigint;
    sharesBurned = sharesHeld - sharesAfter;
  } catch (e) {
    rows.push({
      agent: 'yield',
      event: `unpark.shares-read failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160),
      ok: 'err',
    });
  }

  rows.push({
    agent: 'yield',
    event: `unpark.confirmed tx=${txHash} shares-burned=${sharesBurned.toString()} assets-out=${formatUnits(requestedAtomic, decimals)} ${symbol} status=${rcpt.status} blk=${rcpt.blockNumber} gas=${rcpt.gasUsed}`,
    ok: rcpt.status === 'success' ? 'ok' : 'err',
  });

  return {
    ok: true,
    rows,
    txHash,
    receiver,
    blockNumber: rcpt.blockNumber,
    gasUsed: rcpt.gasUsed,
    sharesBurned,
    assetsOut: requestedAtomic,
  };
}
