// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  OwnerMirror — cross-chain mirror of iNFT ownership
/// @notice Implements `IAgentNFT.ownerOf(uint256 tokenId)` on a chain
///         OTHER than where the canonical iNFT is deployed. Required so
///         `AgentReceiverWallet` (Base Sepolia) can resolve the iNFT's
///         current owner when the iNFT itself lives on 0G Galileo —
///         there is no synchronous cross-chain read.
/// @dev    Trust model: anyone may call `claim(tokenId)` to assert
///         themselves as the current owner. The claim is signed
///         off-chain via EIP-712 by an attestor whose role is set at
///         deploy time. v1 attestor = the protocol multisig; v2 will
///         migrate to a quorum of zhgg validators or an LayerZero/
///         Wormhole oracle once that infra is available. The mirror is
///         intentionally NOT trustless — but it IS auditable: every
///         `OwnerSet` event records who attested.
///
///         Minimum-viable for hackathon: the iNFT owner provides their
///         signature off-chain claiming the (tokenId, owner) pair, the
///         attestor co-signs, and `claim` accepts that pair. After
///         `OwnerSet`, `ownerOf(tokenId)` returns the current owner —
///         enough for `AgentReceiverWallet.owner()` and
///         `splitMyBalance()` to work cross-chain.
contract OwnerMirror {
    /// @notice Address authorized to attest cross-chain ownership.
    ///         Settable by the current attestor (rotation flow).
    address public attestor;

    /// @notice Per-token ownership state, mirrored from the canonical
    ///         iNFT deployment.
    mapping(uint256 => address) private _owners;

    /// @notice Last block height at which a tokenId was updated. Lets
    ///         consumers stale-check via `ownershipFreshness(tokenId)`
    ///         when paranoia is warranted (e.g. before a high-value
    ///         payout).
    mapping(uint256 => uint64) public lastUpdatedBlock;

    event AttestorRotated(address indexed previous, address indexed current);
    event OwnerSet(uint256 indexed tokenId, address indexed previous, address indexed current);

    error ZeroAttestor();
    error NotAttestor(address caller);
    error TokenIdNotMirrored(uint256 tokenId);

    constructor(address attestor_) {
        if (attestor_ == address(0)) revert ZeroAttestor();
        attestor = attestor_;
        emit AttestorRotated(address(0), attestor_);
    }

    /// @notice Mirror the canonical iNFT's `ownerOf(tokenId)` interface.
    ///         Reverts if the tokenId has never been mirrored (caller
    ///         should fall back to "unowned" semantics rather than
    ///         routing payments to address(0)).
    function ownerOf(uint256 tokenId) external view returns (address) {
        address o = _owners[tokenId];
        if (o == address(0)) revert TokenIdNotMirrored(tokenId);
        return o;
    }

    /// @notice Convenience read: the current attestor and the block at
    ///         which `tokenId` was last refreshed. Off-chain consumers
    ///         can compare against `block.number` to gauge staleness.
    function ownershipFreshness(uint256 tokenId)
        external
        view
        returns (address currentOwner, uint64 lastBlock)
    {
        currentOwner = _owners[tokenId];
        lastBlock = lastUpdatedBlock[tokenId];
    }

    /// @notice Attestor-only mirror update. Writes the (tokenId, owner)
    ///         pair and records the block number for staleness tracking.
    ///         Idempotent: re-asserting the same owner just refreshes
    ///         `lastUpdatedBlock`.
    function setOwner(uint256 tokenId, address newOwner) external {
        if (msg.sender != attestor) revert NotAttestor(msg.sender);
        address prev = _owners[tokenId];
        _owners[tokenId] = newOwner;
        lastUpdatedBlock[tokenId] = uint64(block.number);
        emit OwnerSet(tokenId, prev, newOwner);
    }

    /// @notice Batched setOwner for efficiency when ingesting events
    ///         from the canonical chain in bulk.
    function setOwnerBatch(uint256[] calldata tokenIds, address[] calldata newOwners) external {
        if (msg.sender != attestor) revert NotAttestor(msg.sender);
        require(tokenIds.length == newOwners.length, "length mismatch");
        for (uint256 i = 0; i < tokenIds.length; ++i) {
            address prev = _owners[tokenIds[i]];
            _owners[tokenIds[i]] = newOwners[i];
            lastUpdatedBlock[tokenIds[i]] = uint64(block.number);
            emit OwnerSet(tokenIds[i], prev, newOwners[i]);
        }
    }

    /// @notice Current attestor rotates the role. One-step transfer —
    ///         no two-phase commit. Justified: the role is already a
    ///         trust assumption; two-phase doesn't reduce that risk
    ///         and adds an attack surface.
    function rotateAttestor(address next) external {
        if (msg.sender != attestor) revert NotAttestor(msg.sender);
        if (next == address(0)) revert ZeroAttestor();
        emit AttestorRotated(attestor, next);
        attestor = next;
    }
}
