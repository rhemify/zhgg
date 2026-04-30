// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAgentNFT {
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IFeeSplitter {
    function splitERC20(IERC20 asset, uint256 totalAmount, address agentOwner) external;
    function MIN_SPLIT_AMOUNT() external view returns (uint256);
}

/// @title  AgentReceiverWallet — public-trigger smart wallet for Turnkey-bridged payouts
/// @notice One contract per iNFT. KeeperHub treats this address as the
///         "creator wallet" for an agent so the 70% leg of marketplace
///         settlement lands here. Because the iNFT owner's actual KH
///         creator key is in Turnkey custody (only KH /sign endpoint can
///         sign), the wallet has to be triggerable by anyone — the
///         public `splitMyBalance(asset)` fans the held balance through
///         FeeSplitter (85/5/5/5), removing the "Turnkey can't sign
///         FeeSplitter" blocker in `apps/demo/src/keeperhub-marketplace.ts`.
/// @dev    Owner is dynamic — resolved every call via
///         `agentNft.ownerOf(tokenId)` so the receiver follows the iNFT
///         on transfer with zero state migration. ERC-1271
///         `isValidSignature` lets KH provisioning verify a signature
///         from the current iNFT owner's EOA.
contract AgentReceiverWallet is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;
    bytes4 internal constant ERC1271_FAIL  = 0xffffffff;

    IAgentNFT     public immutable agentNft;
    IFeeSplitter public immutable feeSplitter;
    uint256       public immutable tokenId;
    /// @notice Cached at deploy time from `feeSplitter.MIN_SPLIT_AMOUNT()`.
    ///         Lets the hot path short-circuit on dust without making an
    ///         external call to the splitter every `splitMyBalance`.
    uint256       public immutable minSplitAmount;

    event BalanceSplit(address indexed asset, uint256 amount, address indexed ownerAtSplit, address indexed caller);
    event Withdrawn(address indexed asset, address indexed to, uint256 amount, address indexed owner);
    /// @notice Emitted when `splitMyBalance` is a no-op because the
    ///         current balance is below the splitter's minimum. Lets a
    ///         keeper bot distinguish "wait for more" from "broken".
    event BelowSplitThreshold(address indexed asset, uint256 balance, uint256 minSplitAmount);

    error NotOwner(address caller, address owner);
    error NothingToSplit(address asset);
    error TokenBurnedOrUnminted(uint256 tokenId);
    error NativeSweepFailed();

    constructor(address agentNft_, address feeSplitter_, uint256 tokenId_) {
        agentNft       = IAgentNFT(agentNft_);
        feeSplitter    = IFeeSplitter(feeSplitter_);
        tokenId        = tokenId_;
        minSplitAmount = IFeeSplitter(feeSplitter_).MIN_SPLIT_AMOUNT();
    }

    /// @notice Live owner of the iNFT this wallet serves. Reverts if burned.
    function owner() public view returns (address o) {
        o = agentNft.ownerOf(tokenId);
        if (o == address(0)) revert TokenBurnedOrUnminted(tokenId);
    }

    /// @notice Pull this wallet's full `asset` balance through `FeeSplitter`,
    ///         routing 85% to the live iNFT owner and 5/5/5 to the
    ///         protocol recipients. Permissionless on purpose — Turnkey
    ///         can't sign this, so anyone (a keeper bot, the owner from
    ///         any address, a UI button) must be able to fire it. The
    ///         splitter is the policy gate: split percentages are
    ///         immutable and the owner leg always lands at
    ///         `ownerOf(tokenId)`, so a malicious caller can only
    ///         accelerate a payout — not redirect it.
    function splitMyBalance(IERC20 asset) external nonReentrant {
        uint256 bal = asset.balanceOf(address(this));
        if (bal == 0) revert NothingToSplit(address(asset));
        // Dust grief defense: if a malicious party airdrops a tiny
        // amount the splitter would reject as `AmountBelowMinimum`, the
        // call would revert with a confusing downstream error. Emit a
        // clear no-op signal instead so keepers can distinguish dust
        // from a real malfunction. Funds remain in the wallet — a later
        // legitimate top-up + retry consolidates them with the dust.
        if (bal < minSplitAmount) {
            emit BelowSplitThreshold(address(asset), bal, minSplitAmount);
            return;
        }

        address ownerNow = owner();

        // Fresh approval per call — set to exactly `bal`, splitter pulls
        // it all, leaving allowance at 0. Avoids the USDT-style "must
        // reset to zero before raising" footgun even though USDC is fine.
        asset.forceApprove(address(feeSplitter), bal);
        feeSplitter.splitERC20(asset, bal, ownerNow);

        emit BalanceSplit(address(asset), bal, ownerNow, msg.sender);
    }

    /// @notice Owner-only direct withdraw — escape hatch for non-USDC
    ///         dust, accidental airdrops, or if FeeSplitter is paused/
    ///         deprecated. The caller must BE the iNFT owner (an EOA
    ///         the owner controls — the iNFT lives on a regular wallet,
    ///         only the KH receiver address is Turnkey-custodied).
    function withdraw(IERC20 asset, address to) external nonReentrant {
        address o = owner();
        if (msg.sender != o) revert NotOwner(msg.sender, o);
        uint256 bal = asset.balanceOf(address(this));
        if (bal == 0) revert NothingToSplit(address(asset));
        asset.safeTransfer(to, bal);
        emit Withdrawn(address(asset), to, bal, o);
    }

    /// @notice ERC-1271 contract signature: returns the magic value iff
    ///         `signature` is a valid ECDSA signature by the current iNFT
    ///         owner over `hash`. Lets KeeperHub register this contract
    ///         as a "smart creator wallet" by asking the owner to sign a
    ///         provisioning challenge.
    /// @dev    Burn-tolerant: when the iNFT is unminted or burned,
    ///         `agentNft.ownerOf` reverts with `ERC721NonexistentToken`.
    ///         ERC-1271 callers (Safe, AA stacks) treat a revert from
    ///         `isValidSignature` as a system error rather than a
    ///         denied signature, which can brick the wallet's
    ///         downstream consumers. Wrap the call so the failure
    ///         surfaces as `ERC1271_FAIL` per the standard.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err, ) = hash.tryRecover(signature);
        if (err != ECDSA.RecoverError.NoError) return ERC1271_FAIL;
        if (recovered == address(0)) return ERC1271_FAIL;
        try agentNft.ownerOf(tokenId) returns (address ownerNow) {
            if (ownerNow == address(0)) return ERC1271_FAIL;
            return recovered == ownerNow ? ERC1271_MAGIC : ERC1271_FAIL;
        } catch {
            return ERC1271_FAIL;
        }
    }

    receive() external payable {}

    function withdrawNative(address payable to) external nonReentrant {
        address o = owner();
        if (msg.sender != o) revert NotOwner(msg.sender, o);
        uint256 bal = address(this).balance;
        (bool ok, ) = to.call{value: bal}("");
        if (!ok) revert NativeSweepFailed();
    }
}
