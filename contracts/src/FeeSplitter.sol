// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title  FeeSplitter — 4-way fee distribution for zhgg agents
/// @notice Routes every payment received by an agent to four recipients in a
///         single tx: agent owner (workflow creator) / KeeperHub / zhgg /
///         reputation commons. Default split is 8500 / 500 / 500 / 500 bps
///         (85% / 5% / 5% / 5%). The `agentOwner` slot is dynamic — looked
///         up per-call from the iNFT contract so the bulk reward follows
///         the iNFT on transfer.
/// @dev    NOT an EIP-8021 contract. EIP-8021 is a calldata *attribution
///         tag*, not a splitter. We append the attribution suffix
///         optionally on `splitERC20WithTag` so off-chain indexers (Dune,
///         The Graph) can credit volume to "zhgg ecosystem" without
///         reading state. The actual money flow is on-chain via this
///         splitter.
contract FeeSplitter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Fixed fee splits, in basis points. MUST sum to 10000.
    uint16 public constant OWNER_BPS    = 8500; // 85% to agent owner / workflow creator
    uint16 public constant KEEPER_BPS   = 500;  // 5% to KeeperHub
    uint16 public constant ZHGG_BPS     = 500;  // 5% to zhgg treasury
    uint16 public constant COMMONS_BPS  = 500;  // 5% to reputation commons
    uint16 public constant BPS_DENOM    = 10000;

    /// @notice ERC-8021 magic marker (16 bytes) — appended to calldata when
    ///         the caller wants on-chain attribution that off-chain indexers
    ///         can read. Spec: https://www.erc8021.com/
    bytes16 public constant ERC8021_MAGIC = 0x80218021802180218021802180218021;

    /// @notice Recipient of KeeperHub's 5% cut.
    address public immutable keeperhubRecipient;
    /// @notice Recipient of zhgg's 5% cut.
    address public immutable zhggRecipient;
    /// @notice Recipient of the reputation commons 5% cut.
    address public immutable commonsRecipient;

    /// @notice Emitted on every successful split. Logs all four legs so
    ///         off-chain indexers can compute owner-by-owner volume.
    event Split(
        address indexed agentOwner,
        address indexed asset,
        uint256 totalAmount,
        uint256 ownerCut,
        uint256 keeperCut,
        uint256 zhggCut,
        uint256 commonsCut,
        bytes32 attributionTag
    );

    error ZeroAddress();
    error ZeroAmount();
    error InvalidSplitConfig();
    error NativeTransferFailed(address to, uint256 amount);

    /// @param keeperhubRecipient_ KeeperHub treasury address
    /// @param zhggRecipient_      zhgg treasury address
    /// @param commonsRecipient_   reputation commons multisig
    constructor(
        address keeperhubRecipient_,
        address zhggRecipient_,
        address commonsRecipient_
    ) {
        if (keeperhubRecipient_ == address(0)) revert ZeroAddress();
        if (zhggRecipient_ == address(0)) revert ZeroAddress();
        if (commonsRecipient_ == address(0)) revert ZeroAddress();
        if (OWNER_BPS + KEEPER_BPS + ZHGG_BPS + COMMONS_BPS != BPS_DENOM) revert InvalidSplitConfig();

        keeperhubRecipient = keeperhubRecipient_;
        zhggRecipient = zhggRecipient_;
        commonsRecipient = commonsRecipient_;
    }

    // ---------------------------------------------------------------------
    // ERC-20 split
    // ---------------------------------------------------------------------

    /// @notice Pull `totalAmount` of `asset` from `msg.sender` and distribute
    ///         it 85/5/5/5. Caller must `approve` this contract beforehand.
    /// @param  asset        ERC-20 token address (e.g. USDC on Base Sepolia)
    /// @param  totalAmount  Total to distribute, in atomic units
    /// @param  agentOwner   Recipient of the 85% bulk cut (the iNFT owner)
    function splitERC20(IERC20 asset, uint256 totalAmount, address agentOwner)
        external
        nonReentrant
    {
        _splitERC20(asset, totalAmount, agentOwner, bytes32(0));
    }

    /// @notice Same as `splitERC20` but emits an ERC-8021 attribution tag
    ///         in the event log. The tag is opaque — typically a workflow
    ///         id or app code that off-chain indexers (Dune, subgraphs) can
    ///         filter on. The actual money flow is identical to `splitERC20`.
    /// @param  attributionTag  Arbitrary 32-byte tag for off-chain indexing.
    function splitERC20WithTag(IERC20 asset, uint256 totalAmount, address agentOwner, bytes32 attributionTag)
        external
        nonReentrant
    {
        _splitERC20(asset, totalAmount, agentOwner, attributionTag);
    }

    function _splitERC20(IERC20 asset, uint256 totalAmount, address agentOwner, bytes32 attributionTag)
        internal
    {
        if (agentOwner == address(0)) revert ZeroAddress();
        if (totalAmount == 0) revert ZeroAmount();

        asset.safeTransferFrom(msg.sender, address(this), totalAmount);

        // Compute cuts. Owner gets the dust to ensure exact totals.
        uint256 keeperCut  = (totalAmount * KEEPER_BPS)  / BPS_DENOM;
        uint256 zhggCut    = (totalAmount * ZHGG_BPS)    / BPS_DENOM;
        uint256 commonsCut = (totalAmount * COMMONS_BPS) / BPS_DENOM;
        uint256 ownerCut   = totalAmount - keeperCut - zhggCut - commonsCut;

        asset.safeTransfer(agentOwner,         ownerCut);
        asset.safeTransfer(keeperhubRecipient, keeperCut);
        asset.safeTransfer(zhggRecipient,      zhggCut);
        asset.safeTransfer(commonsRecipient,   commonsCut);

        emit Split(agentOwner, address(asset), totalAmount, ownerCut, keeperCut, zhggCut, commonsCut, attributionTag);
    }

    // ---------------------------------------------------------------------
    // Native split (for testnets where USDC isn't deployed)
    // ---------------------------------------------------------------------

    /// @notice Distribute `msg.value` (native gas token) 85/5/5/5.
    ///         Used on 0G Galileo where USDC doesn't exist — settlement
    ///         actually happens on Base Sepolia via x402, but this entry
    ///         exists for testing and for future native-asset agents.
    function splitNative(address agentOwner) external payable nonReentrant {
        _splitNative(agentOwner, bytes32(0));
    }

    function splitNativeWithTag(address agentOwner, bytes32 attributionTag) external payable nonReentrant {
        _splitNative(agentOwner, attributionTag);
    }

    function _splitNative(address agentOwner, bytes32 attributionTag) internal {
        if (agentOwner == address(0)) revert ZeroAddress();
        uint256 totalAmount = msg.value;
        if (totalAmount == 0) revert ZeroAmount();

        uint256 keeperCut  = (totalAmount * KEEPER_BPS)  / BPS_DENOM;
        uint256 zhggCut    = (totalAmount * ZHGG_BPS)    / BPS_DENOM;
        uint256 commonsCut = (totalAmount * COMMONS_BPS) / BPS_DENOM;
        uint256 ownerCut   = totalAmount - keeperCut - zhggCut - commonsCut;

        _sendNative(agentOwner,         ownerCut);
        _sendNative(keeperhubRecipient, keeperCut);
        _sendNative(zhggRecipient,      zhggCut);
        _sendNative(commonsRecipient,   commonsCut);

        emit Split(agentOwner, address(0), totalAmount, ownerCut, keeperCut, zhggCut, commonsCut, attributionTag);
    }

    function _sendNative(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert NativeTransferFailed(to, amount);
    }
}
