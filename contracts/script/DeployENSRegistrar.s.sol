// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ENSRegistrar, INameWrapper} from "../src/ENSRegistrar.sol";

/// @title  DeployENSRegistrar
/// @notice Env-driven deploy of `ENSRegistrar` for `*.zhgg.eth` subname
///         minting. Works on Sepolia (free, hackathon) and mainnet.
///
/// Required env:
///   ENS_NAMEWRAPPER     NameWrapper address on the target chain
///                        - Sepolia: 0x0635513f179D50A207757E05759CbD106d7dFcE8
///                        - Mainnet: 0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401
///   ZHGG_PARENT_NODE    bytes32 namehash of "zhgg.eth"
///                        - Pre-computed: 0xc125028538f6772d932bf6e6911fa54f803889dffd23eed5ee1f6d97c8f1cd5d
///                        - Verify: `cast namehash zhgg.eth`
///
/// Optional env:
///   PRIVATE_KEY         Deployer key. Else use `--account` / `--ledger`.
///
/// Usage:
///   forge script script/DeployENSRegistrar.s.sol:DeployENSRegistrar \
///     --rpc-url $SEPOLIA_RPC --broadcast --verify
contract DeployENSRegistrar is Script {
    function run() external returns (ENSRegistrar registrar) {
        address nameWrapper = vm.envAddress("ENS_NAMEWRAPPER");
        bytes32 parentNode = vm.envBytes32("ZHGG_PARENT_NODE");

        require(nameWrapper != address(0), "ENS_NAMEWRAPPER unset");
        require(parentNode != bytes32(0), "ZHGG_PARENT_NODE unset");

        // Deployer: prefer PRIVATE_KEY env, else fall back to default
        // sender (set via --account / --ledger / --private-key on CLI).
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address deployer;
        if (pk != 0) {
            deployer = vm.addr(pk);
            vm.startBroadcast(pk);
        } else {
            deployer = msg.sender;
            vm.startBroadcast();
        }

        registrar = new ENSRegistrar(INameWrapper(nameWrapper), parentNode);

        vm.stopBroadcast();

        console2.log("=========================================");
        console2.log("ENSRegistrar deployed");
        console2.log("=========================================");
        console2.log("chainId       :", block.chainid);
        console2.log("registrar     :", address(registrar));
        console2.log("nameWrapper   :", nameWrapper);
        console2.log("owner (you)   :", deployer);
        console2.log("parent node   :");
        console2.logBytes32(parentNode);
        console2.log("default fuses :", registrar.DEFAULT_FUSES());
        console2.log("=========================================");
        console2.log("");
        console2.log("NEXT STEP -- run as the parent-name owner of zhgg.eth:");
        console2.log("");
        console2.log("  cast send \\");
        console2.log("    %s \\", nameWrapper);
        console2.log("    'setApprovalForAll(address,bool)' \\");
        console2.log("    %s true \\", address(registrar));
        console2.log("    --rpc-url $RPC_URL \\");
        console2.log("    --private-key $PARENT_OWNER_PK");
        console2.log("");
        console2.log("Until that approval is set, mintSubname() reverts NotApprovedForAll.");
    }
}
