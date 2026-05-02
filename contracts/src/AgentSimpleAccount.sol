// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IAccount, IEntryPoint, PackedUserOperation} from "./interfaces/IAccount.sol";

/// @title  AgentSimpleAccount — ERC-4337 v0.7 smart account for zhgg agents
/// @notice The agent's iNFT owner key is the canonical signer. The account
///         validates UserOperations against that EOA's signature, lets the
///         EntryPoint settle gas (optionally via an ERC-20 paymaster so
///         the agent never holds ETH), and exposes `execute` /
///         `executeBatch` so the calldata leg can target Uniswap, the
///         FeeSplitter, the DelegationManager, etc.
/// @dev    This is intentionally minimal — no plugins, no module slots,
///         no upgrade path. v1 ships a hard-pinned implementation and a
///         CREATE2 factory; v2 (post-hackathon) can swap to a proxy if
///         the iNFT owner ever wants to migrate. The "owner is dynamic"
///         pattern from `AgentReceiverWallet` is NOT replicated here:
///         AA accounts MUST have a stable signer for the EntryPoint's
///         signature aggregator to work. To rotate ownership, the
///         current owner deploys a new account and migrates funds.
contract AgentSimpleAccount is IAccount {
    using MessageHashUtils for bytes32;

    /// @notice The canonical EntryPoint contract per ERC-4337 v0.7. Set
    ///         once at deploy. Live address (immutable across all EVM
    ///         chains): `0x0000000071727De22E5E9d8BAf0edAc6f37da032`.
    IEntryPoint public immutable entryPoint;

    /// @notice The EOA whose signature authorizes UserOps. For zhgg
    ///         agents this is the iNFT owner's hot key.
    address public immutable owner;

    event AccountCreated(address indexed account, address indexed owner, address entryPoint);
    event Executed(address indexed target, uint256 value, bytes4 selector);

    error NotEntryPoint(address caller);
    error NotEntryPointOrSelf(address caller);
    error CallFailed(bytes returnData);
    error LengthMismatch();

    constructor(address entryPoint_, address owner_) {
        require(entryPoint_ != address(0), "AgentSimpleAccount: zero entry point");
        require(owner_ != address(0), "AgentSimpleAccount: zero owner");
        entryPoint = IEntryPoint(entryPoint_);
        owner = owner_;
        emit AccountCreated(address(this), owner_, entryPoint_);
    }

    /// @notice EntryPoint hook. Called once per UserOp. Verifies the
    ///         signature against `owner` and pre-funds the EntryPoint
    ///         with any missing account funds.
    /// @return validationData  0 = signature OK; 1 = signature failed
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external override returns (uint256 validationData) {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint(msg.sender);

        // ECDSA recovery against the v4 prefixed hash. Ethers / viem
        // both produce signatures over `eth_sign`-style prefixed
        // digests, so we apply the prefix on-chain to match.
        bytes32 prefixed = userOpHash.toEthSignedMessageHash();
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(prefixed, userOp.signature);
        if (err != ECDSA.RecoverError.NoError || recovered != owner) {
            // Per ERC-4337 spec: returning 1 (vs reverting) lets the
            // EntryPoint surface a clean SignatureValidation failure.
            validationData = 1;
        } else {
            validationData = 0;
        }

        // Prefund the EntryPoint if it asked for missing funds. Failure
        // here MUST NOT revert (the EntryPoint will revert the whole
        // op if it doesn't get its prefund).
        if (missingAccountFunds > 0) {
            (bool ok, ) = payable(address(entryPoint)).call{
                value: missingAccountFunds, gas: type(uint256).max
            }("");
            // Spec says we ignore the success result; if false the
            // EntryPoint's downstream logic reverts the op.
            ok;
        }
    }

    /// @notice Execute a single call. Callable only by the EntryPoint
    ///         (during op execution) or the account itself (for
    ///         in-account self-batches). Owner cannot call this
    ///         directly — they must go through the EntryPoint.
    function execute(address target, uint256 value, bytes calldata data)
        external
        returns (bytes memory)
    {
        _requireFromEntryPointOrSelf();
        bytes4 selector = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
        emit Executed(target, value, selector);
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
        return ret;
    }

    /// @notice Execute a batch atomically. Any failure reverts all.
    function executeBatch(address[] calldata targets, uint256[] calldata values, bytes[] calldata datas)
        external
        returns (bytes[] memory results)
    {
        _requireFromEntryPointOrSelf();
        if (targets.length != values.length || targets.length != datas.length) revert LengthMismatch();
        results = new bytes[](targets.length);
        for (uint256 i = 0; i < targets.length; ++i) {
            bytes4 selector = datas[i].length >= 4 ? bytes4(datas[i][:4]) : bytes4(0);
            emit Executed(targets[i], values[i], selector);
            (bool ok, bytes memory ret) = targets[i].call{value: values[i]}(datas[i]);
            if (!ok) revert CallFailed(ret);
            results[i] = ret;
        }
    }

    /// @notice Receive ETH so the EntryPoint can deposit on behalf of
    ///         this account, and so a paymaster's eventual refund lands
    ///         here.
    receive() external payable {}

    /// @notice Convenience: deposit ETH into the EntryPoint as gas
    ///         prepayment so future UserOps don't need `missingAccountFunds`
    ///         to be non-zero. Owner-callable directly.
    function addDeposit() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    /// @notice Withdraw the account's EntryPoint deposit. Owner-only.
    function withdrawDepositTo(address payable to, uint256 amount) external {
        require(msg.sender == owner, "AgentSimpleAccount: not owner");
        entryPoint.withdrawTo(to, amount);
    }

    function _requireFromEntryPointOrSelf() internal view {
        if (msg.sender != address(entryPoint) && msg.sender != address(this)) {
            revert NotEntryPointOrSelf(msg.sender);
        }
    }
}
