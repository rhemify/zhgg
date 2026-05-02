// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Packed user operation per ERC-4337 v0.7. Two `bytes32` fields
///         pack pairs of `uint128` to halve calldata cost on the bundler
///         path: the high 16 bytes carry the verification leg, the low
///         16 bytes carry the call leg.
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;             // factory address (20) || factoryData
    bytes callData;
    bytes32 accountGasLimits;   // verificationGasLimit (uint128) || callGasLimit (uint128)
    uint256 preVerificationGas;
    bytes32 gasFees;            // maxPriorityFeePerGas (uint128) || maxFeePerGas (uint128)
    bytes paymasterAndData;     // paymaster (20) || paymasterVerificationGasLimit (uint128) || paymasterPostOpGasLimit (uint128) || paymasterData
    bytes signature;
}

/// @notice ERC-4337 account validation interface. The EntryPoint calls
///         this on every UserOp; the account verifies the signature,
///         optionally bumps a nonce, and pre-funds any missing gas.
interface IAccount {
    /// @notice Validate a user operation.
    /// @param  userOp              The op to validate
    /// @param  userOpHash          keccak256(domain || op fields) — what the signer signed
    /// @param  missingAccountFunds Wei the account must transfer to EntryPoint to cover gas
    /// @return validationData      Packed (sigFailed:1, validUntil:6, validAfter:6) bytes —
    ///                             0 = sig OK forever; 1 = sig failed; otherwise time-bounded
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external returns (uint256 validationData);
}

/// @notice Subset of the ERC-4337 v0.7 EntryPoint interface that
///         account contracts depend on. The account calls `getNonce`
///         (not always — many implementations rely on EntryPoint to
///         increment internally) and `depositTo` for prefunding when
///         the account holds its own ETH.
interface IEntryPoint {
    function getNonce(address sender, uint192 key) external view returns (uint256 nonce);
    function depositTo(address account) external payable;
    function balanceOf(address account) external view returns (uint256);
    function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external;
}
