// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "../interfaces/IERC4626.sol";

/// @title  MockERC4626 — minimal share-accounting vault for tests + Sepolia demo
/// @notice Real ERC-4626 share math (deposits transfer underlying in, mints
///         shares; redeems/withdraws burn shares + transfer underlying out).
///         When underlying is sent directly to the vault contract, the
///         per-share asset value rises — i.e. the wallet's redemption pulls
///         out original principal + its proportional share of the yield.
/// @dev    Intentionally NOT a stub. Tests rely on real share/asset
///         conversion to prove the AgentReceiverWallet idle-USDC parking
///         path actually captures yield. Donation-attack defenses are
///         omitted because the demo deployer controls the initial deposit;
///         do NOT use this contract in production.
contract MockERC4626 is ERC20, IERC4626 {
    IERC20 internal immutable _asset;
    bool   public paused;

    constructor(IERC20 underlying) ERC20("Mock 4626", "m4626") {
        _asset = underlying;
    }

    /// @notice Test-only kill switch — exercises the wallet's
    ///         `_redeemFromVaultBestEffort` try/catch.
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

    function maxRedeem(address owner_) external view returns (uint256) {
        return balanceOf(owner_);
    }

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
