// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Minimal NameWrapper interface used by this registrar.
/// @dev    The full NameWrapper has 30+ functions — we only need
///         setSubnodeOwner. ENS deploys NameWrapper at:
///         - Mainnet:        0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401
///         - Sepolia:        0x0635513f179D50A207757E05759CbD106d7dFcE8
interface INameWrapper {
    /// @notice Mints a subname under a wrapped parent name.
    /// @param  parentNode  namehash of the parent (e.g. namehash("zhgg.eth"))
    /// @param  label       subname label (e.g. "audit" for audit.zhgg.eth)
    /// @param  owner       recipient of the subname
    /// @param  fuses       fuse bitmask (CANNOT_UNWRAP, etc.)
    /// @param  expiry      subname expiry (typically inherits parent expiry)
    /// @return node        namehash of the newly created subname
    function setSubnodeOwner(
        bytes32 parentNode,
        string calldata label,
        address owner,
        uint32 fuses,
        uint64 expiry
    ) external returns (bytes32 node);

    /// @notice Approval check — registrar must be approved for the parent name.
    function isApprovedForAll(address account, address operator) external view returns (bool);

    /// @notice Owner of a wrapped name. NameWrapper is ERC-1155, the id is
    ///         `uint256(node)` where node is the namehash. Used by the
    ///         registrar to look up the *actual* parent-name owner rather
    ///         than guessing from the registrar's own `Ownable.owner()`.
    function ownerOf(uint256 id) external view returns (address);
}

/// @title  ENSRegistrar — chainId-agnostic subname minter for zhgg.eth
/// @notice Mints `*.zhgg.eth` subnames for zhgg agents. The parent name is
///         wrapped via ENS NameWrapper; the parent owner (zhgg multisig)
///         calls `setApprovalForAll(this, true)` on NameWrapper once after
///         deployment, after which this registrar can mint subnames freely.
/// @dev    This contract is chain-agnostic — deploy on Ethereum mainnet
///         (where zhgg.eth lives) OR on Sepolia (fallback path). The
///         NameWrapper address is set in the constructor.
///
///         Fuse semantics (uint32 bitmask, from ENS NameWrapper):
///         - CANNOT_UNWRAP             = 1
///         - CANNOT_BURN_FUSES         = 2
///         - CANNOT_TRANSFER           = 4
///         - CANNOT_SET_RESOLVER       = 8
///         - CANNOT_SET_TTL            = 16
///         - CANNOT_CREATE_SUBDOMAIN   = 32
///         - PARENT_CANNOT_CONTROL     = 65536
///
///         Default for agent subnames: PARENT_CANNOT_CONTROL | CANNOT_UNWRAP
///         (= 65537), so the agent's owner controls their own subname even
///         after we transfer it to them.
contract ENSRegistrar is Ownable {
    /// @notice The NameWrapper contract on this chain.
    INameWrapper public immutable nameWrapper;

    /// @notice The namehash of the parent name (e.g. namehash("zhgg.eth")).
    bytes32 public immutable parentNode;

    /// @notice Default fuse bitmask applied to minted subnames.
    uint32 public constant DEFAULT_FUSES = 65537; // PARENT_CANNOT_CONTROL | CANNOT_UNWRAP

    /// @notice Whether anyone can mint subnames, or only the owner.
    /// @dev    Default false (owner-only). Owner can flip to true to
    ///         enable the open onboarding flow for `mint-agent` CLI.
    bool public publicMintEnabled;

    /// @notice Per-label-hash record. Used to prevent re-minting and to
    ///         track who claimed each label.
    mapping(bytes32 => address) public labelClaimedBy;

    event SubnameMinted(string label, bytes32 indexed labelhash, address indexed owner, bytes32 node);
    event PublicMintToggled(bool enabled);

    error NotApprovedForAll();
    error LabelAlreadyClaimed();
    error PublicMintDisabled();
    error EmptyLabel();

    /// @param nameWrapper_ NameWrapper contract address (mainnet or testnet)
    /// @param parentNode_  namehash of the parent name
    constructor(INameWrapper nameWrapper_, bytes32 parentNode_) Ownable(msg.sender) {
        nameWrapper = nameWrapper_;
        parentNode = parentNode_;
    }

    // ---------------------------------------------------------------------
    // Mint
    // ---------------------------------------------------------------------

    /// @notice Owner-only: mint a subname for an agent.
    /// @param  label  subname label (e.g. "audit")
    /// @param  owner  recipient of the subname
    /// @return node   namehash of the newly created subname
    function mintSubname(string calldata label, address owner)
        external
        onlyOwner
        returns (bytes32 node)
    {
        return _mintSubname(label, owner);
    }

    /// @notice Public-mint: any caller can claim a subname when enabled.
    ///         Used by the `mint-agent` CLI to demonstrate open onboarding.
    function publicMintSubname(string calldata label)
        external
        returns (bytes32 node)
    {
        if (!publicMintEnabled) revert PublicMintDisabled();
        return _mintSubname(label, msg.sender);
    }

    function _mintSubname(string calldata label, address owner) internal returns (bytes32 node) {
        if (bytes(label).length == 0) revert EmptyLabel();

        bytes32 labelhash = keccak256(bytes(label));
        if (labelClaimedBy[labelhash] != address(0)) revert LabelAlreadyClaimed();

        // Look up the ACTUAL parent name owner from NameWrapper (the
        // ERC-1155 owner of the wrapped node). Previous version probed
        // `Ownable.owner()` of the registrar — silently wrong if registrar
        // ownership ever diverged from the parent-name owner (e.g. owner
        // rotated to a new multisig but parent name still held by old key,
        // or registrar deployed under a hot key and transferred). The
        // approval check now verifies the right account regardless of
        // registrar ownership.
        address parentOwner = nameWrapper.ownerOf(uint256(parentNode));
        if (!nameWrapper.isApprovedForAll(parentOwner, address(this))) {
            revert NotApprovedForAll();
        }

        // Inherit parent expiry by passing 0 — NameWrapper substitutes the
        // parent's expiry. Fuses default to PARENT_CANNOT_CONTROL | CANNOT_UNWRAP.
        node = nameWrapper.setSubnodeOwner(parentNode, label, owner, DEFAULT_FUSES, 0);

        labelClaimedBy[labelhash] = owner;
        emit SubnameMinted(label, labelhash, owner, node);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @notice Toggle public mint. Used to enable the `mint-agent` CLI flow.
    function setPublicMintEnabled(bool enabled) external onlyOwner {
        publicMintEnabled = enabled;
        emit PublicMintToggled(enabled);
    }
}
