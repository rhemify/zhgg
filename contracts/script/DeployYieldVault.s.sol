// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC4626} from "../src/mocks/MockERC4626.sol";

/// @title  DeployYieldVault — Base Sepolia mock-yield vault for the demo
/// @notice Deploys a `MockERC4626` wrapping a configured USDC ERC-20.
///         AgentReceiverWallets can then be pointed at this vault via
///         `setYieldVault(address)` so idle USDC actually earns
///         (donation-simulated) yield in demos.
///
/// Target chain: Base Sepolia
///   chainId  : 84532
///   RPC      : https://sepolia.base.org
///   explorer : https://sepolia.basescan.org
///
/// Required env:
///   USDC_ADDRESS    Base Sepolia USDC (or any ERC-20 with 6 decimals)
///                   used as the vault's underlying. The receiver wallet
///                   pulls `vault.asset()` and caches it as `yieldAsset`,
///                   so this MUST match the asset the wallet expects to
///                   split (USDC for the FeeSplitter path).
///
/// Optional env:
///   PRIVATE_KEY     Deployer key. Else use `--account` / `--ledger`.
///   BASESCAN_API_KEY For `--verify`.
///
/// Why this is a separate script (not folded into DeployBaseContracts):
///   - Vaults are owner-rotatable on the wallet (`setYieldVault`), so
///     they don't need to ship in lockstep with the factory.
///   - On mainnet the canonical vault is Aave's StaticATokenLM; the mock
///     should never run there. Keeping the deployment file separate
///     makes the chainid guard (`require(block.chainid == 84532)`)
///     explicit and prevents accidental mainnet broadcast.
///   - Lets demo operators redeploy a fresh vault between scenarios
///     without re-broadcasting the whole base set.
///
/// Usage:
///   USDC_ADDRESS=0x... \
///   forge script script/DeployYieldVault.s.sol:DeployYieldVault \
///     --rpc-url $BASE_SEPOLIA_RPC --broadcast --verify
///
/// Wiring after deploy (single iNFT example):
///   forge script script/DeployYieldVault.s.sol logs the vault address.
///   Then, from the iNFT owner's account:
///     cast send $RECEIVER_WALLET "setYieldVault(address)" $VAULT_ADDRESS
contract DeployYieldVault is Script {
    function run() external returns (MockERC4626 vault) {
        require(block.chainid == 84532, "Wrong chain: expected Base Sepolia (84532)");

        address usdc = vm.envAddress("USDC_ADDRESS");
        require(usdc != address(0), "USDC_ADDRESS unset");

        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address deployer;
        if (pk != 0) {
            deployer = vm.addr(pk);
            vm.startBroadcast(pk);
        } else {
            deployer = msg.sender;
            vm.startBroadcast();
        }

        vault = new MockERC4626(IERC20(usdc));

        vm.stopBroadcast();

        console2.log("=========================================");
        console2.log("Yield vault deploy complete (Base Sepolia)");
        console2.log("=========================================");
        console2.log("chainId        :", block.chainid);
        console2.log("deployer       :", deployer);
        console2.log("MockERC4626    :", address(vault));
        console2.log("  underlying   :", usdc);
        console2.log("");
        console2.log("Explorer URL:");
        console2.log("  https://sepolia.basescan.org/address/%s", address(vault));
        console2.log("=========================================");
        console2.log("");
        console2.log("Save as env var:");
        console2.log("  YIELD_VAULT_ADDRESS=%s", address(vault));
        console2.log("");
        console2.log("Next: from each iNFT owner, point the wallet at it:");
        console2.log("  cast send <RECEIVER_WALLET> \"setYieldVault(address)\" %s", address(vault));
    }
}
