// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {AgentSimpleAccount} from "./AgentSimpleAccount.sol";

/// @title  AgentSimpleAccountFactory — CREATE2 deployer for ERC-4337 accounts
/// @notice Address is fully determined by `(owner, salt)`. The bundler
///         can deploy the account on first UserOp by passing
///         `initCode = factory || createAccount.selector || abi.encode(owner, salt)`
///         in the UserOp; this factory is what the EntryPoint calls.
contract AgentSimpleAccountFactory {
    address public immutable entryPoint;

    event AccountFactoryDeploy(address indexed owner, bytes32 indexed salt, address account);

    constructor(address entryPoint_) {
        require(entryPoint_ != address(0), "Factory: zero entry point");
        entryPoint = entryPoint_;
    }

    /// @notice Deploy or return the existing AA account for `(owner, salt)`.
    ///         Idempotent — calling twice returns the same address. The
    ///         EntryPoint calls this exactly when `initCode` is set on a
    ///         UserOp; subsequent ops have empty initCode.
    function createAccount(address owner, bytes32 salt) external returns (AgentSimpleAccount) {
        address predicted = predict(owner, salt);
        uint256 codeSize;
        assembly { codeSize := extcodesize(predicted) }
        if (codeSize > 0) return AgentSimpleAccount(payable(predicted));

        AgentSimpleAccount acc = new AgentSimpleAccount{salt: salt}(entryPoint, owner);
        emit AccountFactoryDeploy(owner, salt, address(acc));
        return acc;
    }

    /// @notice Predict the CREATE2 address for `(owner, salt)`. Pure of
    ///         deployment state.
    function predict(address owner, bytes32 salt) public view returns (address) {
        bytes memory init = abi.encodePacked(
            type(AgentSimpleAccount).creationCode,
            abi.encode(entryPoint, owner)
        );
        return Create2.computeAddress(salt, keccak256(init));
    }
}
