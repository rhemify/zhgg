// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ISpendCap {
    function spendPermission(
        address account,
        address asset,
        bytes32 permissionId,
        uint128 amount
    ) external;
}

/// @notice The smart wallet (delegator) MUST implement this so the
///         DelegationManager can route execution through it. Target
///         contracts then see the wallet as `msg.sender`, which is what
///         lets pre-existing approvals + SpendCap.spendPermission work
///         (SpendCap checks `msg.sender == account`).
interface IDelegationExecutor {
    function executeViaDelegation(address target, uint256 value, bytes calldata data)
        external
        returns (bytes memory);
}

/// @title  DelegationManager — minimal ERC-7710 redeemer
/// @notice Implements the single ERC-7710 interface verbatim
///         (`redeemDelegations`) with a content-derived caveat set:
///         allowed-target list + ETH-value cap + expiry + optional
///         SpendCap.spendPermission debit per redemption. Atomic batch:
///         any failure reverts all. Per-delegation salt + on-chain
///         redeemed map prevent replay.
/// @dev    Only single-call mode (`bytes32(0)`) is supported in v1.
///         Multi-execution mode IDs from ERC-7579 are deferred — they
///         add complexity without unlocking new zhgg use cases. The
///         delegator must be a contract implementing
///         `IDelegationExecutor` (typically `AgentReceiverWallet`); the
///         signature is checked via ERC-1271 (`isValidSignature`) so
///         the iNFT owner's EOA sig is what actually authorizes.
contract DelegationManager is EIP712, ReentrancyGuard {
    using ECDSA for bytes32;

    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;
    bytes32 internal constant DELEGATION_TYPEHASH = keccak256(
        "Delegation(address delegator,address delegate,address[] allowedTargets,uint128 maxValuePerCall,uint64 expiresAt,bytes32 salt,address spendCapAsset,bytes32 permissionId,uint128 maxAmountPerRedeem)"
    );
    /// @notice Single supported ERC-7579 mode for v1: single-call execution.
    bytes32 internal constant MODE_SINGLE_CALL = bytes32(0);

    /// @notice Address of the on-chain SpendCap manager. Optional —
    ///         delegations with `spendCapAsset == address(0)` skip the
    ///         debit. Set once at deploy.
    ISpendCap public immutable spendCap;

    /// @notice Tracks redeemed `(delegator, salt)` pairs. Single-use
    ///         delegations: once redeemed, the same salt cannot be
    ///         used again. To grant multi-use authority, the delegator
    ///         signs N delegations with N distinct salts.
    mapping(bytes32 => bool) public redeemed;

    struct Delegation {
        address delegator;            // smart wallet (must implement IDelegationExecutor)
        address delegate;             // agent permitted to redeem (msg.sender at redeem time)
        address[] allowedTargets;     // empty = no targets allowed (revert)
        uint128 maxValuePerCall;      // wei cap per Execution.value
        uint64  expiresAt;            // unix seconds; redeem fails after
        bytes32 salt;                 // delegator-chosen, unique per delegation
        address spendCapAsset;        // 0 = skip cap debit
        bytes32 permissionId;         // ERC-7715 bucket on spendCap (when asset != 0)
        uint128 maxAmountPerRedeem;   // amount debited from cap per redeem
    }

    struct Execution {
        address target;
        uint256 value;
        bytes data;
    }

    event DelegationRedeemed(
        address indexed delegator,
        address indexed delegate,
        bytes32 indexed delegationHash,
        address target,
        uint256 value
    );

    error LengthMismatch();
    error UnsupportedMode(bytes32 mode);
    error InvalidSignature();
    error WrongDelegate(address expected, address caller);
    error AlreadyRedeemed(bytes32 redemptionKey);
    error DelegationExpired(uint64 expiresAt, uint256 nowTs);
    error TargetNotAllowed(address target);
    error ValueExceedsCap(uint256 requested, uint128 max);
    error EmptyAllowedTargets();
    error ExecutionFailed(uint256 index, bytes returnData);

    constructor(address spendCap_) EIP712("zhgg.DelegationManager", "1") {
        spendCap = ISpendCap(spendCap_); // address(0) is allowed (skip cap debits)
    }

    /// @notice ERC-7710 redemption entry point.
    /// @param  permissionContexts  ABI-encoded `(Delegation, bytes signature)` per redemption
    /// @param  modes               ERC-7579 mode IDs; only `bytes32(0)` (single-call) supported
    /// @param  executionCallData   ABI-encoded `Execution` per redemption
    function redeemDelegations(
        bytes[] calldata permissionContexts,
        bytes32[] calldata modes,
        bytes[] calldata executionCallData
    ) external payable nonReentrant {
        if (
            permissionContexts.length != modes.length
                || permissionContexts.length != executionCallData.length
        ) revert LengthMismatch();

        for (uint256 i = 0; i < permissionContexts.length; ++i) {
            _redeemOne(permissionContexts[i], modes[i], executionCallData[i], i);
        }
    }

    /// @notice Compute the EIP-712 digest a delegator signs. Useful for
    ///         off-chain helpers (`packages/workflow/src/delegation.ts`).
    function hashDelegation(Delegation calldata d) external view returns (bytes32) {
        return _hashTypedDataV4(_structHash(d));
    }

    /// @dev See `hashDelegation`. Internal struct-hash skips the domain
    ///      separator so it can be reused inside `_redeemOne`.
    function _structHash(Delegation memory d) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                DELEGATION_TYPEHASH,
                d.delegator,
                d.delegate,
                keccak256(abi.encodePacked(d.allowedTargets)),
                d.maxValuePerCall,
                d.expiresAt,
                d.salt,
                d.spendCapAsset,
                d.permissionId,
                d.maxAmountPerRedeem
            )
        );
    }

    function _redeemOne(
        bytes calldata context,
        bytes32 mode,
        bytes calldata executionData,
        uint256 /*index*/
    ) internal {
        if (mode != MODE_SINGLE_CALL) revert UnsupportedMode(mode);

        (Delegation memory d, bytes memory sig) = abi.decode(context, (Delegation, bytes));

        if (d.allowedTargets.length == 0) revert EmptyAllowedTargets();

        // Caller must be the delegate; otherwise anyone observing the
        // signed delegation in the mempool could redeem it.
        if (msg.sender != d.delegate) revert WrongDelegate(d.delegate, msg.sender);

        // Time bound — revert AFTER expiry. Inclusive of `expiresAt`.
        if (block.timestamp > d.expiresAt) revert DelegationExpired(d.expiresAt, block.timestamp);

        // Single-use replay defense per `(delegator, salt)`. The salt
        // is chosen by the delegator — they may issue concurrent
        // delegations with distinct salts to support parallel intents.
        bytes32 redemptionKey = keccak256(abi.encode(d.delegator, d.salt));
        if (redeemed[redemptionKey]) revert AlreadyRedeemed(redemptionKey);
        redeemed[redemptionKey] = true;

        // Signature check via ERC-1271 (smart-wallet delegator).
        bytes32 digest = _hashTypedDataV4(_structHash(d));
        if (IERC1271(d.delegator).isValidSignature(digest, sig) != ERC1271_MAGIC) {
            revert InvalidSignature();
        }

        // Decode the execution payload.
        Execution memory exec = abi.decode(executionData, (Execution));

        // Caveat: target allowlist.
        if (!_targetAllowed(d.allowedTargets, exec.target)) revert TargetNotAllowed(exec.target);

        // Caveat: value cap.
        if (exec.value > d.maxValuePerCall) revert ValueExceedsCap(exec.value, d.maxValuePerCall);

        // Caveat: SpendCap debit (optional). The cap is debited BEFORE
        // execution so a target that pulls more than `maxAmountPerRedeem`
        // still gets bounded loss — the manager doesn't track post-call
        // balance changes. The delegator's wallet is responsible for
        // having approved `target` for the right amount separately.
        if (d.spendCapAsset != address(0) && address(spendCap) != address(0)) {
            // The wallet (d.delegator) calls SpendCap, so msg.sender at
            // SpendCap == account. We invoke SpendCap THROUGH the wallet
            // so the existing `msg.sender == account` invariant on
            // SpendCap.spendPermission holds.
            IDelegationExecutor(d.delegator).executeViaDelegation(
                address(spendCap),
                0,
                abi.encodeCall(
                    ISpendCap.spendPermission,
                    (d.delegator, d.spendCapAsset, d.permissionId, d.maxAmountPerRedeem)
                )
            );
        }

        // Execute through the delegator wallet so target sees the wallet
        // as msg.sender. This is what makes pre-existing approvals
        // (`usdc.approve(uniswap, ...)`) work without funneling funds
        // through this manager.
        bytes memory ret = IDelegationExecutor(d.delegator).executeViaDelegation(
            exec.target, exec.value, exec.data
        );
        // Suppress the unused-return warning while keeping a hook for
        // future success-data forwarding.
        ret;

        emit DelegationRedeemed(d.delegator, d.delegate, digest, exec.target, exec.value);
    }

    function _targetAllowed(address[] memory list, address target) internal pure returns (bool) {
        for (uint256 i = 0; i < list.length; ++i) {
            if (list[i] == target) return true;
        }
        return false;
    }
}
