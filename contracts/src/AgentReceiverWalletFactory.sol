// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {AgentReceiverWallet} from "./AgentReceiverWallet.sol";

/// @title  AgentReceiverWalletFactory — deterministic deployer per iNFT
/// @notice One receiver wallet per `tokenId`, addressed via CREATE2 with
///         the tokenId itself as the salt. KeeperHub can be told the
///         address BEFORE the contract is deployed — predict, register
///         on KH, then deploy when the first payment is about to settle.
contract AgentReceiverWalletFactory {
    address public immutable agentNft;
    address public immutable feeSplitter;

    event ReceiverDeployed(uint256 indexed tokenId, address indexed wallet, address indexed deployer);

    constructor(address agentNft_, address feeSplitter_) {
        agentNft    = agentNft_;
        feeSplitter = feeSplitter_;
    }

    function _salt(uint256 tokenId) internal pure returns (bytes32) {
        return bytes32(tokenId);
    }

    /// @notice Init-code hash for offchain prediction. Deterministic
    ///         across clients because constructor args are fixed in
    ///         immutables on the deployed factory.
    function initCodeHash(uint256 tokenId) public view returns (bytes32) {
        bytes memory code = abi.encodePacked(
            type(AgentReceiverWallet).creationCode,
            abi.encode(agentNft, feeSplitter, tokenId)
        );
        return keccak256(code);
    }

    /// @notice Predict the receiver address for `tokenId`. Pure of
    ///         deployment state — same answer before and after deploy.
    function predict(uint256 tokenId) external view returns (address) {
        return Create2.computeAddress(_salt(tokenId), initCodeHash(tokenId));
    }

    /// @notice Deploy the receiver. Permissionless — anyone can pay gas
    ///         to provision an agent's wallet. Reverts if already
    ///         deployed (CREATE2 collision is the EVM's natural protection).
    function deploy(uint256 tokenId) external returns (address wallet) {
        bytes memory code = abi.encodePacked(
            type(AgentReceiverWallet).creationCode,
            abi.encode(agentNft, feeSplitter, tokenId)
        );
        wallet = Create2.deploy(0, _salt(tokenId), code);
        emit ReceiverDeployed(tokenId, wallet, msg.sender);
    }

    function statusOf(uint256 tokenId) external view returns (address addr, bool deployed) {
        addr = Create2.computeAddress(_salt(tokenId), initCodeHash(tokenId));
        uint256 size;
        assembly { size := extcodesize(addr) }
        deployed = size > 0;
    }
}
