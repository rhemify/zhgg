/// Receiver-wallet helpers — predict + deploy the per-iNFT
/// `AgentReceiverWallet` so KeeperHub can register it as the agent's
/// "creator wallet" before the first marketplace settlement.
///
/// Why predict before deploy: KH provisioning needs an EVM address to
/// register against the sub-org. CREATE2 lets us hand them the address
/// derived purely from `(factory, agentNft, feeSplitter, tokenId)` —
/// no chain interaction. The contract is deployed lazily, just before
/// (or just after) the first payment lands.

import {
  encodeAbiParameters,
  encodePacked,
  getCreate2Address,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from 'viem';

import type { MintExecutor } from './steps.js';

const FACTORY_ABI = [
  {
    type: 'function',
    name: 'deploy',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: 'wallet', type: 'address' }],
  },
] as const;

export interface PredictArgs {
  factory: Address;
  agentNft: Address;
  feeSplitter: Address;
  tokenId: bigint;
  /// Compiled `AgentReceiverWallet` creationCode (creation bytecode +
  /// constructor args removed). In live mode this comes from the forge
  /// build output. The factory does the same `abi.encodePacked` so
  /// caller and on-chain match byte-for-byte.
  creationCode: Hex;
}

/// Compute the deterministic CREATE2 address for `tokenId`. Pure,
/// off-chain. Requires the AgentReceiverWallet creationCode produced by
/// `forge build` (see `contracts/out/AgentReceiverWallet.sol/AgentReceiverWallet.json`).
export function predictReceiverWalletAddress(args: PredictArgs): Address {
  const ctorArgs = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [args.agentNft, args.feeSplitter, args.tokenId]
  );
  const initCode = encodePacked(['bytes', 'bytes'], [args.creationCode, ctorArgs]);
  return getCreate2Address({
    from: args.factory,
    bytecodeHash: keccak256(initCode),
    salt: toHex(args.tokenId, { size: 32 }),
  });
}

export interface DeployReceiverArgs {
  factory: Address;
  tokenId: bigint;
}

export interface DeployReceiverResult {
  wallet: Address;
  txHash: Hex;
}

/// Deploy the receiver wallet for `tokenId` via the factory. Caller
/// should first check `predictReceiverWalletAddress` and
/// `publicClient.getCode(predicted)` to skip when already deployed —
/// re-deploying reverts (CREATE2 collision). Uses the same
/// `MintExecutor` shape as the other mint-agent steps so the existing
/// CLI ergonomics carry over.
export async function deployReceiverWallet(
  exec: MintExecutor,
  args: DeployReceiverArgs
): Promise<DeployReceiverResult> {
  const out = await exec.call<Address>({
    address: args.factory,
    abi: FACTORY_ABI,
    functionName: 'deploy',
    args: [args.tokenId],
  });
  return { wallet: out.result, txHash: out.txHash };
}
