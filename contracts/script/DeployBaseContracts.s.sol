// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {SpendCap} from "../src/SpendCap.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";

/// @title  DeployBaseContracts
/// @notice Deploys the Base Sepolia pair: SpendCap (ERC-7715-style cap
///         manager, zero-arg constructor) + FeeSplitter (4-way 85/5/5/5
///         splitter, takes 3 immutable recipients).
///
/// Target chain: Base Sepolia
///   chainId  : 84532
///   RPC      : https://sepolia.base.org
///   explorer : https://sepolia.basescan.org
///
/// Required env (FeeSplitter constructor args):
///   KH_TREASURY        keeperhub recipient (5%)
///   ZHGG_TREASURY      zhgg treasury (5%)
///   COMMONS_TREASURY   reputation commons (5%)
///   The 85% leg is set per-call via `splitERC20(asset, amount, agentOwner)`.
///
/// Optional env:
///   PRIVATE_KEY        Deployer key. Else use `--account` / `--ledger`.
///   BASESCAN_API_KEY   For `--verify`.
///
/// Usage:
///   forge script script/DeployBaseContracts.s.sol:DeployBaseContracts \
///     --rpc-url $BASE_SEPOLIA_RPC \
///     --broadcast --verify
contract DeployBaseContracts is Script {
    function run() external returns (SpendCap spendCap, FeeSplitter feeSplitter) {
        require(block.chainid == 84532, "Wrong chain: expected Base Sepolia (84532)");

        address kh = vm.envAddress("KH_TREASURY");
        address zhgg = vm.envAddress("ZHGG_TREASURY");
        address commons = vm.envAddress("COMMONS_TREASURY");

        require(kh != address(0), "KH_TREASURY unset");
        require(zhgg != address(0), "ZHGG_TREASURY unset");
        require(commons != address(0), "COMMONS_TREASURY unset");

        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address deployer;
        if (pk != 0) {
            deployer = vm.addr(pk);
            vm.startBroadcast(pk);
        } else {
            deployer = msg.sender;
            vm.startBroadcast();
        }

        spendCap = new SpendCap();
        feeSplitter = new FeeSplitter(kh, zhgg, commons);

        vm.stopBroadcast();

        console2.log("=========================================");
        console2.log("Base Sepolia deploy complete");
        console2.log("=========================================");
        console2.log("chainId        :", block.chainid);
        console2.log("deployer       :", deployer);
        console2.log("SpendCap       :", address(spendCap));
        console2.log("FeeSplitter    :", address(feeSplitter));
        console2.log("  kh recipient :", kh);
        console2.log("  zhgg treas.  :", zhgg);
        console2.log("  commons rec. :", commons);
        console2.log("");
        console2.log("Explorer URLs:");
        console2.log("  https://sepolia.basescan.org/address/%s", address(spendCap));
        console2.log("  https://sepolia.basescan.org/address/%s", address(feeSplitter));
        console2.log("=========================================");
        console2.log("");
        console2.log("Save these as env vars:");
        console2.log("  SPEND_CAP_ADDRESS=%s", address(spendCap));
        console2.log("  FEE_SPLITTER_ADDRESS=%s", address(feeSplitter));
    }
}
