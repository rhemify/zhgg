// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AgentNFT} from "../src/AgentNFT.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {AxiomCommit} from "../src/AxiomCommit.sol";

/// @title  Deploy0GContracts
/// @notice One-shot deploy of the 0G Galileo pair: AgentNFT (ERC-7857
///         iNFT) + AgentRegistry (ERC-8004 adapter). Both have zero-arg
///         constructors.
///
/// Target chain: 0G Galileo testnet
///   chainId  : 16602
///   RPC      : https://evmrpc-testnet.0g.ai
///   explorer : https://chainscan-galileo.0g.ai
///   faucet   : https://faucet.0g.ai (0.1 0G / wallet / day)
///
/// Optional env:
///   ZG_PRIVATE_KEY  Deployer key (preferred name).
///   PRIVATE_KEY     Alternate deployer key var.
///   Else use `--account` / `--ledger` on CLI.
///
/// Usage:
///   forge script script/Deploy0GContracts.s.sol:Deploy0GContracts \
///     --rpc-url https://evmrpc-testnet.0g.ai \
///     --broadcast --slow --legacy
///
/// Verification: 0G Chainscan is Blockscout-derived, NOT Etherscan v2.
/// Etherscan-style `--verify` returns 404. Either skip --verify (safe
/// default for hackathon testnet demos) or pass:
///   --verifier blockscout --verifier-url https://chainscan-galileo.0g.ai/api
contract Deploy0GContracts is Script {
    function run()
        external
        returns (AgentNFT nft, AgentRegistry registry, AxiomCommit axiom)
    {
        require(block.chainid == 16602, "Wrong chain: expected 0G Galileo (16602)");

        uint256 pk = vm.envOr("ZG_PRIVATE_KEY", uint256(0));
        if (pk == 0) pk = vm.envOr("PRIVATE_KEY", uint256(0));

        address deployer;
        if (pk != 0) {
            deployer = vm.addr(pk);
            vm.startBroadcast(pk);
        } else {
            deployer = msg.sender;
            vm.startBroadcast();
        }

        nft = new AgentNFT();
        registry = new AgentRegistry();
        // AxiomCommit lives on the same chain as the iNFT so an audit
        // agent can commit a plan hash and pin its memoryRoot in the
        // same wallet/chain context (Steps 3 + 9 of the always-active
        // loop). Wired to the iNFT for owner-only `commitPlan` —
        // operators authorized via `setOperator(tokenId, addr, true)`.
        axiom = new AxiomCommit(address(nft));

        vm.stopBroadcast();

        console2.log("=========================================");
        console2.log("0G Galileo deploy complete");
        console2.log("=========================================");
        console2.log("chainId        :", block.chainid);
        console2.log("deployer       :", deployer);
        console2.log("AgentNFT       :", address(nft));
        console2.log("AgentRegistry  :", address(registry));
        console2.log("AxiomCommit    :", address(axiom));
        console2.log("");
        console2.log("Explorer URLs:");
        console2.log("  https://chainscan-galileo.0g.ai/address/%s", address(nft));
        console2.log("  https://chainscan-galileo.0g.ai/address/%s", address(registry));
        console2.log("  https://chainscan-galileo.0g.ai/address/%s", address(axiom));
        console2.log("=========================================");
        console2.log("");
        console2.log("Save these as env vars:");
        console2.log("  AGENT_NFT_ADDRESS=%s", address(nft));
        console2.log("  AGENT_REGISTRY_ADDRESS=%s", address(registry));
        console2.log("  AXIOM_COMMIT_ADDRESS=%s", address(axiom));
    }
}
