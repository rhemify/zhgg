// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {AgentNFT} from "../src/AgentNFT.sol";
import {ACPJobStub} from "../src/ACPJobStub.sol";

/// @title  Deploy
/// @notice Deploys AgentNFT + ACPJobStub to 0G Galileo and mints a demo iNFT.
///         Run: forge script script/Deploy.s.sol --rpc-url $ZG_RPC_URL --broadcast
///         Required env: PRIVATE_KEY (deployer/operator), ZG_RPC_URL.
///         After broadcast, copy the printed addresses into the project .env:
///         AGENT_NFT_ADDRESS / ACP_STUB_ADDRESS / ZG_INFT_TOKEN_ID.
contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        console2.log("Deployer:", deployer);

        vm.startBroadcast(deployerKey);

        AgentNFT agentNft = new AgentNFT();
        console2.log("AgentNFT deployed at:", address(agentNft));

        ACPJobStub acpStub = new ACPJobStub();
        console2.log("ACPJobStub deployed at:", address(acpStub));

        // Mint the demo iNFT to the deployer with a permissive capability
        // manifest. Production callers will mint their own with stricter limits.
        bytes memory manifest = bytes(
            '{"allowedModes":["fast","verified","consensus","pipeline"],"maxCostUsd":0.01,"maxLatencyMs":5000}'
        );
        uint256 tokenId = agentNft.mint(deployer, manifest);
        console2.log("Demo iNFT minted, tokenId:", tokenId);

        vm.stopBroadcast();

        // ──────────────────────────────────────────────────────────────────
        console2.log("");
        console2.log("Add to .env:");
        console2.log("AGENT_NFT_ADDRESS=", address(agentNft));
        console2.log("ACP_STUB_ADDRESS=", address(acpStub));
        console2.log("ZG_INFT_TOKEN_ID=", tokenId);
    }
}
