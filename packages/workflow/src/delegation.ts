/// ERC-7710 delegation builder + signer for zhgg's DelegationManager.
///
/// Pure viem — no ethers, no SDK. Builds the canonical Delegation struct,
/// produces the EIP-712 digest matching `DelegationManager.hashDelegation`,
/// and signs via either an EOA private key or any wallet client's
/// `signTypedData`. The output `permissionContext` is what gets passed to
/// `redeemDelegations(bytes[], bytes32[], bytes[])` per the ERC-7710 spec.
///
/// Critical: the EIP-712 typehash + struct shape MUST stay byte-for-byte
/// in sync with `DelegationManager.sol::DELEGATION_TYPEHASH`. The forge
/// test `test_redeem_executesThroughDelegatorWallet` exercises the full
/// round-trip; if either side drifts, the manager's `InvalidSignature`
/// revert fires immediately.

import {
  encodeAbiParameters,
  hashTypedData,
  type Address,
  type Hex,
  type WalletClient,
} from 'viem';

export interface Delegation {
  delegator: Address;
  delegate: Address;
  allowedTargets: readonly Address[];
  /// ETH/native value cap per Execution.value (wei)
  maxValuePerCall: bigint;
  /// Unix seconds; redeem fails AFTER this timestamp (inclusive)
  expiresAt: bigint;
  /// Delegator-chosen, unique per delegation (replay defense)
  salt: Hex;
  /// 0x000…000 = no SpendCap debit
  spendCapAsset: Address;
  permissionId: Hex;
  /// Amount debited from the SpendCap bucket on each redemption
  maxAmountPerRedeem: bigint;
}

export interface Execution {
  target: Address;
  value: bigint;
  data: Hex;
}

/// EIP-712 domain matching `EIP712("zhgg.DelegationManager", "1")` in the
/// Solidity contract. `verifyingContract` and `chainId` must be set per
/// deployment by the caller.
export interface DelegationDomain {
  chainId: number;
  verifyingContract: Address;
}

/// EIP-712 types. The `Delegation` typehash MUST match the contract:
/// `keccak256("Delegation(address delegator,address delegate,address[] allowedTargets,uint128 maxValuePerCall,uint64 expiresAt,bytes32 salt,address spendCapAsset,bytes32 permissionId,uint128 maxAmountPerRedeem)")`
export const DELEGATION_TYPES = {
  Delegation: [
    { name: 'delegator', type: 'address' },
    { name: 'delegate', type: 'address' },
    { name: 'allowedTargets', type: 'address[]' },
    { name: 'maxValuePerCall', type: 'uint128' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'salt', type: 'bytes32' },
    { name: 'spendCapAsset', type: 'address' },
    { name: 'permissionId', type: 'bytes32' },
    { name: 'maxAmountPerRedeem', type: 'uint128' },
  ],
} as const;

/// Compute the EIP-712 digest the delegator signs. Equivalent to
/// `DelegationManager.hashDelegation(d)` on-chain — useful for off-chain
/// verification without a node round-trip.
export function delegationDigest(domain: DelegationDomain, d: Delegation): Hex {
  return hashTypedData({
    domain: {
      name: 'zhgg.DelegationManager',
      version: '1',
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    types: DELEGATION_TYPES,
    primaryType: 'Delegation',
    message: {
      delegator: d.delegator,
      delegate: d.delegate,
      allowedTargets: [...d.allowedTargets],
      maxValuePerCall: d.maxValuePerCall,
      expiresAt: d.expiresAt,
      salt: d.salt,
      spendCapAsset: d.spendCapAsset,
      permissionId: d.permissionId,
      maxAmountPerRedeem: d.maxAmountPerRedeem,
    },
  });
}

/// Sign a delegation via a viem `WalletClient` — works with both
/// browser-injected (MetaMask) and server-side (privateKeyToAccount)
/// signers. The wallet's account MUST be the iNFT owner whose ERC-1271
/// `isValidSignature` will validate at redeem time.
export async function signDelegation(
  walletClient: WalletClient,
  domain: DelegationDomain,
  d: Delegation
): Promise<Hex> {
  const account = walletClient.account;
  if (!account) throw new Error('signDelegation: walletClient has no account');
  return walletClient.signTypedData({
    account,
    domain: {
      name: 'zhgg.DelegationManager',
      version: '1',
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    types: DELEGATION_TYPES,
    primaryType: 'Delegation',
    message: {
      delegator: d.delegator,
      delegate: d.delegate,
      allowedTargets: [...d.allowedTargets],
      maxValuePerCall: d.maxValuePerCall,
      expiresAt: d.expiresAt,
      salt: d.salt,
      spendCapAsset: d.spendCapAsset,
      permissionId: d.permissionId,
      maxAmountPerRedeem: d.maxAmountPerRedeem,
    },
  });
}

/// ABI-encode `(Delegation, bytes signature)` for the
/// `redeemDelegations.permissionContexts[i]` slot. The contract decodes
/// this exact shape via `abi.decode(context, (Delegation, bytes))`.
export function encodePermissionContext(d: Delegation, signature: Hex): Hex {
  return encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { name: 'delegator', type: 'address' },
          { name: 'delegate', type: 'address' },
          { name: 'allowedTargets', type: 'address[]' },
          { name: 'maxValuePerCall', type: 'uint128' },
          { name: 'expiresAt', type: 'uint64' },
          { name: 'salt', type: 'bytes32' },
          { name: 'spendCapAsset', type: 'address' },
          { name: 'permissionId', type: 'bytes32' },
          { name: 'maxAmountPerRedeem', type: 'uint128' },
        ],
      },
      { type: 'bytes' },
    ],
    [
      {
        delegator: d.delegator,
        delegate: d.delegate,
        allowedTargets: [...d.allowedTargets] as readonly Address[],
        maxValuePerCall: d.maxValuePerCall,
        expiresAt: d.expiresAt,
        salt: d.salt,
        spendCapAsset: d.spendCapAsset,
        permissionId: d.permissionId,
        maxAmountPerRedeem: d.maxAmountPerRedeem,
      },
      signature,
    ]
  );
}

/// ABI-encode `Execution` for the `executionCallData[i]` slot.
export function encodeExecution(exec: Execution): Hex {
  return encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { name: 'target', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
    [exec]
  );
}

/// Single-call ERC-7579 mode — currently the only mode the manager
/// supports. Re-exported here so callers don't have to remember the
/// magic value.
export const MODE_SINGLE_CALL: Hex =
  '0x0000000000000000000000000000000000000000000000000000000000000000';
