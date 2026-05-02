// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgentNFT} from "../src/AgentNFT.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";
import {AgentReceiverWallet} from "../src/AgentReceiverWallet.sol";
import {AgentReceiverWalletFactory} from "../src/AgentReceiverWalletFactory.sol";
import {IERC4626} from "../src/interfaces/IERC4626.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
    function decimals() public pure override returns (uint8) { return 6; }
}

/// Real ERC-4626 vault for tests — proper 1:1 share accounting (no
/// donation-attack defense, but that's fine for in-test deterministic
/// behavior). NOT a stub: deposits actually transfer underlying in,
/// shares mint, withdraws/redeems burn shares + transfer underlying out.
contract MockERC4626 is ERC20, IERC4626 {
    IERC20 internal immutable _asset;
    bool   public paused;

    constructor(IERC20 underlying) ERC20("Mock 4626", "m4626") {
        _asset = underlying;
    }

    function setPaused(bool v) external { paused = v; }

    function asset() external view returns (address) { return address(_asset); }

    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 supply = totalSupply();
        return supply == 0 ? assets : (assets * supply) / _asset.balanceOf(address(this));
    }
    function convertToAssets(uint256 shares) public view returns (uint256) {
        uint256 supply = totalSupply();
        return supply == 0 ? shares : (shares * _asset.balanceOf(address(this))) / supply;
    }
    function maxWithdraw(address owner_) external view returns (uint256) {
        return convertToAssets(balanceOf(owner_));
    }
    function maxRedeem(address owner_) external view returns (uint256) { return balanceOf(owner_); }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        require(!paused, "MockERC4626: paused");
        shares = convertToShares(assets);
        _asset.transferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
    }

    function withdraw(uint256 assets, address receiver, address owner_)
        external
        returns (uint256 shares)
    {
        require(!paused, "MockERC4626: paused");
        shares = convertToShares(assets);
        if (msg.sender != owner_) _spendAllowance(owner_, msg.sender, shares);
        _burn(owner_, shares);
        _asset.transfer(receiver, assets);
    }

    function redeem(uint256 shares, address receiver, address owner_)
        external
        returns (uint256 assets)
    {
        require(!paused, "MockERC4626: paused");
        assets = convertToAssets(shares);
        if (msg.sender != owner_) _spendAllowance(owner_, msg.sender, shares);
        _burn(owner_, shares);
        _asset.transfer(receiver, assets);
    }
}

contract AgentReceiverWalletVaultTest is Test {
    AgentNFT internal nft;
    FeeSplitter internal splitter;
    AgentReceiverWalletFactory internal factory;
    MockUSDC internal usdc;
    MockERC4626 internal vault;
    AgentReceiverWallet internal wallet;

    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");
    address internal kh = address(0xBEEF);
    address internal zhgg = address(0xCAFE);
    address internal commons = address(0xDADA);

    uint256 internal tokenId;

    function setUp() public {
        nft = new AgentNFT();
        splitter = new FeeSplitter(kh, zhgg, commons);
        factory = new AgentReceiverWalletFactory(address(nft), address(splitter));
        usdc = new MockUSDC();
        vault = new MockERC4626(IERC20(address(usdc)));

        tokenId = nft.mint(owner, hex"");
        wallet = AgentReceiverWallet(payable(factory.deploy(tokenId)));
    }

    function test_setYieldVault_ownerOnly() public {
        vm.prank(stranger);
        vm.expectRevert();
        wallet.setYieldVault(IERC4626(address(vault)));

        vm.prank(owner);
        wallet.setYieldVault(IERC4626(address(vault)));
        assertEq(address(wallet.yieldVault()), address(vault));
        assertEq(wallet.yieldAsset(), address(usdc));
    }

    function test_setYieldVault_zeroDisablesRouting() public {
        vm.prank(owner);
        wallet.setYieldVault(IERC4626(address(vault)));
        vm.prank(owner);
        wallet.setYieldVault(IERC4626(address(0)));
        assertEq(address(wallet.yieldVault()), address(0));
        assertEq(wallet.yieldAsset(), address(0));
    }

    function test_parkIdle_movesUSDCIntoVault() public {
        vm.prank(owner);
        wallet.setYieldVault(IERC4626(address(vault)));

        usdc.mint(address(wallet), 1_000e6);
        // Permissionless — anyone may call.
        vm.prank(stranger);
        wallet.parkIdle();

        assertEq(usdc.balanceOf(address(wallet)), 0);
        assertEq(usdc.balanceOf(address(vault)), 1_000e6);
        assertEq(vault.balanceOf(address(wallet)), 1_000e6); // 1:1 shares since vault is empty
    }

    function test_parkIdle_isNoOpWhenNoVault() public {
        usdc.mint(address(wallet), 1_000e6);
        wallet.parkIdle();
        // Funds untouched.
        assertEq(usdc.balanceOf(address(wallet)), 1_000e6);
    }

    function test_parkIdle_isNoOpWhenIdleIsZero() public {
        vm.prank(owner);
        wallet.setYieldVault(IERC4626(address(vault)));
        wallet.parkIdle(); // no idle → no-op
        assertEq(vault.balanceOf(address(wallet)), 0);
    }

    function test_splitMyBalance_redeemsBeforeSplit() public {
        vm.prank(owner);
        wallet.setYieldVault(IERC4626(address(vault)));

        // Deposit 100 USDC into the vault.
        usdc.mint(address(wallet), 100e6);
        wallet.parkIdle();
        assertEq(usdc.balanceOf(address(wallet)), 0);

        // Split — should auto-redeem first.
        vm.prank(stranger);
        wallet.splitMyBalance(IERC20(address(usdc)));

        // 85/5/5/5 of 100e6 (1:1 vault, no yield) = expected dist.
        assertEq(usdc.balanceOf(owner), 85e6);
        assertEq(usdc.balanceOf(kh), 5e6);
        assertEq(usdc.balanceOf(zhgg), 5e6);
        assertEq(usdc.balanceOf(commons), 5e6);
        // Wallet should have zero in both raw and vault now.
        assertEq(usdc.balanceOf(address(wallet)), 0);
        assertEq(vault.balanceOf(address(wallet)), 0);
    }

    function test_splitMyBalance_pausedVaultFailsOpen() public {
        vm.prank(owner);
        wallet.setYieldVault(IERC4626(address(vault)));

        // Park funds.
        usdc.mint(address(wallet), 100e6);
        wallet.parkIdle();
        // Top up wallet with raw USDC too — split should still work
        // using the raw balance even when the vault is paused.
        usdc.mint(address(wallet), 50e6);

        vault.setPaused(true);

        // Split on the raw 50e6 should still work; vault redeem fails
        // gracefully (try/catch in _redeemFromVaultBestEffort).
        vm.prank(stranger);
        wallet.splitMyBalance(IERC20(address(usdc)));

        // 85/5/5/5 of 50e6
        assertEq(usdc.balanceOf(owner), 42_500_000);
        assertEq(usdc.balanceOf(kh), 2_500_000);
        // Vault shares still held — owner can recover via withdrawAllIdle
        // once vault unpauses.
        assertEq(vault.balanceOf(address(wallet)), 100e6);
    }

    function test_withdrawAllIdle_ownerOnly() public {
        vm.prank(owner);
        wallet.setYieldVault(IERC4626(address(vault)));
        usdc.mint(address(wallet), 100e6);
        wallet.parkIdle();

        vm.prank(stranger);
        vm.expectRevert();
        wallet.withdrawAllIdle();

        vm.prank(owner);
        wallet.withdrawAllIdle();
        assertEq(usdc.balanceOf(address(wallet)), 100e6);
        assertEq(vault.balanceOf(address(wallet)), 0);
    }

    function test_withdrawAllIdle_isNoOpWhenNoVault() public {
        vm.prank(owner);
        wallet.withdrawAllIdle(); // no vault → no-op, no revert
    }

    function test_withdrawAllIdle_isNoOpWhenNoShares() public {
        vm.prank(owner);
        wallet.setYieldVault(IERC4626(address(vault)));
        vm.prank(owner);
        wallet.withdrawAllIdle(); // no shares → no-op
    }

    /// Yield-bearing scenario — vault gets 10% interest while funds sit.
    function test_splitMyBalance_capturesEarnedYield() public {
        vm.prank(owner);
        wallet.setYieldVault(IERC4626(address(vault)));
        usdc.mint(address(wallet), 100e6);
        wallet.parkIdle();
        // Wallet has 100 shares = 100e6 USDC equivalent.
        assertEq(vault.balanceOf(address(wallet)), 100e6);

        // Simulate 10% yield by minting USDC directly to the vault.
        usdc.mint(address(vault), 10e6);

        // Now redeem-and-split should pull out 110e6.
        vm.prank(stranger);
        wallet.splitMyBalance(IERC20(address(usdc)));

        // 85% of 110e6 = 93_500_000 to owner.
        assertEq(usdc.balanceOf(owner), 93_500_000);
        assertEq(usdc.balanceOf(kh), 5_500_000);
    }
}
