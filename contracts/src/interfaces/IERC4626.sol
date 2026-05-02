// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal ERC-4626 view + state-mutating surface zhgg uses.
///         Compatible with Aave's StaticATokenLM, Yearn V3, Morpho Blue
///         vaults, etc. Not the full standard — just the methods our
///         AgentReceiverWallet calls.
interface IERC4626 is IERC20 {
    function asset() external view returns (address);
    function convertToShares(uint256 assets) external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function maxWithdraw(address owner) external view returns (uint256);
    function maxRedeem(address owner) external view returns (uint256);

    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 assets, address receiver, address owner)
        external
        returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner)
        external
        returns (uint256 assets);
}
