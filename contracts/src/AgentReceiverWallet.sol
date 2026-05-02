// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC4626} from "./interfaces/IERC4626.sol";

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

    /// @notice Authorized DelegationManager — the only address allowed
    ///         to invoke `executeViaDelegation`. Settable once by the
    ///         current iNFT owner; afterwards immutable from the
    ///         wallet's perspective. ERC-7710 redemptions route through
    ///         this address and target contracts see THIS wallet as
    ///         `msg.sender`, which is what lets pre-existing ERC-20
    ///         approvals + SpendCap.spendPermission work without
    ///         funneling funds through the manager.
    address public delegationManager;
    bool    public delegationManagerLocked;

    /// @notice Optional yield vault. When non-zero, idle balance of
    ///         `vaultAsset()` is parkable in this 4626 vault via
    ///         `parkIdle()`; redemption is automatic before splits via
    ///         `_ensureLiquid()`. Owner-rotatable so a paused vault
    ///         can be migrated. Setting to address(0) is allowed and
    ///         disables yield routing entirely (the safest default).
    IERC4626 public yieldVault;
    /// @notice Cached `vaultAsset` so we avoid repeated external reads
    ///         on the hot path. Refreshed when `setYieldVault` runs.
    address public yieldAsset;

    event BalanceSplit(address indexed asset, uint256 amount, address indexed ownerAtSplit, address indexed caller);
    event Withdrawn(address indexed asset, address indexed to, uint256 amount, address indexed owner);
    /// @notice Emitted when `splitMyBalance` is a no-op because the
    ///         current balance is below the splitter's minimum. Lets a
    ///         keeper bot distinguish "wait for more" from "broken".
    event BelowSplitThreshold(address indexed asset, uint256 balance, uint256 minSplitAmount);
    event DelegationManagerSet(address indexed manager, address indexed setter);
    event DelegationManagerLocked(address indexed setter);
    event DelegationExecuted(address indexed target, uint256 value, bytes4 selector);
    event YieldVaultSet(address indexed vault, address indexed asset, address indexed setter);
    event IdleParked(address indexed vault, address indexed asset, uint256 assets, uint256 shares);
    event IdleRedeemed(address indexed vault, address indexed asset, uint256 shares, uint256 assets);

    error NotOwner(address caller, address owner);
    error NothingToSplit(address asset);
    error TokenBurnedOrUnminted(uint256 tokenId);
    error NativeSweepFailed();
    error DelegationManagerNotSet();
    error DelegationManagerAlreadyLocked();
    error NotDelegationManager(address caller);
    error DelegatedCallFailed(bytes returnData);
    error VaultAssetMismatch(address vaultAsset, address splitAsset);

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
        // If the asset matches the configured yield vault's underlying,
        // pull idle funds back from the vault first. Bounded-loss
        // invariant preserved: redemption failure does NOT brick the
        // split — we fall through to whatever raw balance is held.
        if (address(yieldVault) != address(0) && address(asset) == yieldAsset) {
            _redeemFromVaultBestEffort();
        }

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

    // ---------------------------------------------------------------------
    // ERC-7710 delegation execution
    // ---------------------------------------------------------------------

    /// @notice Owner sets which DelegationManager may invoke
    ///         `executeViaDelegation`. Can be updated until
    ///         `lockDelegationManager` is called, after which it's
    ///         immutable. Lets owners migrate to a new manager
    ///         (e.g. v2 with richer caveats) until they're confident
    ///         the address is correct, then lock for safety.
    function setDelegationManager(address manager) external {
        address o = owner();
        if (msg.sender != o) revert NotOwner(msg.sender, o);
        if (delegationManagerLocked) revert DelegationManagerAlreadyLocked();
        delegationManager = manager;
        emit DelegationManagerSet(manager, o);
    }

    /// @notice Owner permanently locks `delegationManager`. Irreversible.
    function lockDelegationManager() external {
        address o = owner();
        if (msg.sender != o) revert NotOwner(msg.sender, o);
        if (delegationManager == address(0)) revert DelegationManagerNotSet();
        delegationManagerLocked = true;
        emit DelegationManagerLocked(o);
    }

    /// @notice ERC-7710 delegation execution path. ONLY the configured
    ///         DelegationManager may call this. The manager validates
    ///         the delegation off-call (signature, caveats, expiry,
    ///         spend cap), then routes execution through this wallet so
    ///         `target` sees this wallet as `msg.sender`. Required for
    ///         pre-existing ERC-20 approvals and `SpendCap.spendPermission`
    ///         to work without funneling funds through the manager.
    /// @dev    `nonReentrant` is intentionally NOT applied here: the
    ///         DelegationManager's `redeemDelegations` already holds
    ///         the reentrancy lock on its side, and a single redemption
    ///         legitimately calls back into this wallet twice (once for
    ///         the SpendCap debit, once for the actual target call).
    ///         Adding our own guard would deadlock that pattern.
    function executeViaDelegation(address target, uint256 value, bytes calldata data)
        external
        returns (bytes memory)
    {
        if (msg.sender != delegationManager) revert NotDelegationManager(msg.sender);
        // Audit hook — selector is 4 bytes when present, zero otherwise
        // (e.g. plain ETH transfer with empty calldata).
        bytes4 selector = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
        emit DelegationExecuted(target, value, selector);
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert DelegatedCallFailed(ret);
        return ret;
    }

    // ---------------------------------------------------------------------
    // ERC-4626 yield wrapper (Phase 22)
    // ---------------------------------------------------------------------

    /// @notice Owner sets / rotates the yield vault. Setting to zero
    ///         disables yield routing — the safest default. The vault's
    ///         `asset()` is cached in `yieldAsset` so the hot path
    ///         doesn't make an external read per split.
    /// @dev    The owner is responsible for verifying:
    ///           - the vault is reputable (Aave / Yearn V3 / Morpho)
    ///           - the vault's asset matches the splitter's expected USDC
    ///         Setting a hostile vault address is owner-error and breaks
    ///         the bounded-loss invariant. Document loudly.
    function setYieldVault(IERC4626 vault) external {
        address o = owner();
        if (msg.sender != o) revert NotOwner(msg.sender, o);
        yieldVault = vault;
        yieldAsset = address(vault) == address(0) ? address(0) : vault.asset();
        emit YieldVaultSet(address(vault), yieldAsset, o);
    }

    /// @notice Anyone may call to deposit any idle `yieldAsset` balance
    ///         into the vault. Permissionless because it only earns
    ///         yield — no funds move out of the wallet's control.
    function parkIdle() external nonReentrant {
        if (address(yieldVault) == address(0)) return;
        uint256 idle = IERC20(yieldAsset).balanceOf(address(this));
        if (idle == 0) return;
        IERC20(yieldAsset).forceApprove(address(yieldVault), idle);
        uint256 shares = yieldVault.deposit(idle, address(this));
        emit IdleParked(address(yieldVault), yieldAsset, idle, shares);
    }

    /// @notice Owner-only escape hatch — pulls everything back from the
    ///         vault into the wallet, regardless of whether a split is
    ///         imminent. Used when the owner wants to migrate to a new
    ///         vault or the current vault is misbehaving.
    function withdrawAllIdle() external nonReentrant {
        address o = owner();
        if (msg.sender != o) revert NotOwner(msg.sender, o);
        if (address(yieldVault) == address(0)) return;
        uint256 shares = yieldVault.balanceOf(address(this));
        if (shares == 0) return;
        uint256 assets = yieldVault.redeem(shares, address(this), address(this));
        emit IdleRedeemed(address(yieldVault), yieldAsset, shares, assets);
    }

    /// @notice Owner-only partial withdraw — pulls a specific
    ///         `assets` amount of `yieldAsset` back from the vault.
    ///         Useful when the owner wants to free a known amount
    ///         (e.g. just enough to bring the wallet's raw balance
    ///         above `minSplitAmount`) without unwinding the whole
    ///         position. ERC-4626 vault burns the proportional share
    ///         count corresponding to `assets` at current price-per-share,
    ///         so the wallet captures pro-rata yield on the withdrawn slice.
    /// @dev    No-op when no vault is set, mirroring `withdrawAllIdle`.
    ///         `assets == 0` is a no-op (vault would burn zero shares).
    function withdrawIdle(uint256 assets) external nonReentrant {
        address o = owner();
        if (msg.sender != o) revert NotOwner(msg.sender, o);
        if (address(yieldVault) == address(0)) return;
        if (assets == 0) return;
        uint256 sharesBurned = yieldVault.withdraw(assets, address(this), address(this));
        emit IdleRedeemed(address(yieldVault), yieldAsset, sharesBurned, assets);
    }

    /// @dev Hot-path redemption — fails open. If the vault is paused,
    ///      reverts on redeem, or otherwise misbehaves, the split path
    ///      proceeds with whatever raw balance is in the wallet.
    ///      Guarantee: a broken vault never bricks the split.
    function _redeemFromVaultBestEffort() internal {
        IERC4626 v = yieldVault;
        uint256 shares = v.balanceOf(address(this));
        if (shares == 0) return;
        try v.redeem(shares, address(this), address(this)) returns (uint256 assets) {
            emit IdleRedeemed(address(v), yieldAsset, shares, assets);
        } catch {
            // Vault paused / queue / oracle stale — leave shares in
            // place. Owner can call `withdrawAllIdle` later when the
            // vault recovers, OR rotate to a new vault.
        }
    }
}
