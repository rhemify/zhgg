// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {SpendCap} from "../src/SpendCap.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";
import {AgentReceiverWalletFactory} from "../src/AgentReceiverWalletFactory.sol";
import {OwnerMirror} from "../src/OwnerMirror.sol";

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
///   PRIVATE_KEY              Deployer key. Else use `--account` / `--ledger`.
///   BASESCAN_API_KEY         For `--verify`.
///   AGENT_NFT_BASE_MIRROR    Base-Sepolia-resident contract that exposes
///                            `ownerOf(uint256) returns (address)`. When
///                            set, the script also deploys
///                            `AgentReceiverWalletFactory` so KH-paid
///                            USDC can land in a per-iNFT receiver
///                            wallet that fans through FeeSplitter.
///                            CROSS-CHAIN CAVEAT: the canonical AgentNFT
///                            lives on 0G Galileo (chain 16602). The
///                            factory needs a Base-side ownership mirror
///                            because the receiver wallet calls
///                            `ownerOf` synchronously from Base. Either
///                            (a) deploy a minimal mirror that the iNFT
///                            owner self-registers to, or (b) skip this
///                            env var and run the factory deploy in a
///                            separate pass once the mirror exists.
///
/// Usage:
///   forge script script/DeployBaseContracts.s.sol:DeployBaseContracts \
///     --rpc-url $BASE_SEPOLIA_RPC \
///     --broadcast --verify
contract DeployBaseContracts is Script {
    function run()
        external
        returns (
            SpendCap spendCap,
            FeeSplitter feeSplitter,
            AgentReceiverWalletFactory receiverFactory,
            OwnerMirror ownerMirror
        )
    {
        require(block.chainid == 84532, "Wrong chain: expected Base Sepolia (84532)");

        address kh = vm.envAddress("KH_TREASURY");
        address zhgg = vm.envAddress("ZHGG_TREASURY");
        address commons = vm.envAddress("COMMONS_TREASURY");

        require(kh != address(0), "KH_TREASURY unset");
        require(zhgg != address(0), "ZHGG_TREASURY unset");
        require(commons != address(0), "COMMONS_TREASURY unset");

        // OwnerMirror is the Base-resident `ownerOf(uint256)` source.
        // The deployer is the initial attestor (typically the protocol
        // multisig / hot wallet that ingests iNFT-side Transfer events
        // on 0G Galileo and replays them onto Base via `setOwner`).
        // The attestor address is overridable via env; defaults to the
        // deployer.
        address attestor = vm.envOr("OWNER_MIRROR_ATTESTOR", address(0));

        // Whether to wire the receiver factory to the just-deployed
        // OwnerMirror (default true) or skip it. Skipping is only
        // useful for staged deploys where the factory will be deployed
        // later against a different ownerOf source.
        bool wireFactory = vm.envOr("DEPLOY_RECEIVER_FACTORY", true);

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
        ownerMirror = new OwnerMirror(attestor != address(0) ? attestor : deployer);
        if (wireFactory) {
            receiverFactory = new AgentReceiverWalletFactory(address(ownerMirror), address(feeSplitter));
        }

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
        console2.log("OwnerMirror    :", address(ownerMirror));
        console2.log("  attestor     :", attestor != address(0) ? attestor : deployer);
        if (address(receiverFactory) != address(0)) {
            console2.log("ReceiverFactory:", address(receiverFactory));
            console2.log("  ownerOf src  :", address(ownerMirror));
        } else {
            console2.log("ReceiverFactory: skipped (DEPLOY_RECEIVER_FACTORY=false)");
        }
        console2.log("");
        console2.log("Explorer URLs:");
        console2.log("  https://sepolia.basescan.org/address/%s", address(spendCap));
        console2.log("  https://sepolia.basescan.org/address/%s", address(feeSplitter));
        if (address(receiverFactory) != address(0)) {
            console2.log("  https://sepolia.basescan.org/address/%s", address(receiverFactory));
        }
        console2.log("=========================================");
        console2.log("");
        console2.log("Save these as env vars:");
        console2.log("  SPEND_CAP_ADDRESS=%s", address(spendCap));
        console2.log("  FEE_SPLITTER_ADDRESS=%s", address(feeSplitter));
        console2.log("  OWNER_MIRROR_ADDRESS=%s", address(ownerMirror));
        if (address(receiverFactory) != address(0)) {
            console2.log("  RECEIVER_FACTORY_ADDRESS=%s", address(receiverFactory));
        }
    }
}
