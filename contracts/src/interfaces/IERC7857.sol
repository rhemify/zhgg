// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IERC7857 — Intelligent NFT (iNFT) standard interface
/// @notice ERC-721 extension where every token references one or more
///         off-chain encrypted "intelligent data" blobs (model weights,
///         agent memory, capability manifests). The off-chain pointer is
///         typically a `0g://storage/<rootHash>` URI on 0G Storage.
/// @dev    This is the v1 surface used by the zhgg project. Real
///         transfer-validity proofs (ZK / TEE attestations) are deferred
///         to v2 — `iTransferFrom` accepts any non-empty proof array.
interface IERC7857 {
    /// @notice A single off-chain data slot attached to an iNFT.
    /// @param dataHash         keccak256 (or comparable) hash of the
    ///                         encrypted blob stored off-chain.
    /// @param dataDescription  Human/machine-readable pointer, typically a
    ///                         `0g://storage/<rootHash>` URI.
    struct IntelligentData {
        bytes32 dataHash;
        string dataDescription;
    }

    /// @notice Proof bundle required for an iNFT-aware transfer.
    /// @param commitment  Hash committing to the re-encrypted payload.
    /// @param signature   Signature over `commitment` from the verifier
    ///                    (TEE / ZK prover). Verification is a stub in v1.
    struct TransferValidityProof {
        bytes32 commitment;
        bytes signature;
    }

    /// @notice Emitted when a new intelligent data slot is appended.
    event IntelligentDataUpdated(uint256 indexed tokenId, bytes32 dataHash, string dataDescription);

    /// @notice Emitted when a third party pays to use an iNFT.
    event UsageAuthorized(uint256 indexed tokenId, address indexed user, bytes32 intentHash, uint256 royaltyPaid);

    /// @notice Emitted when the owner revokes a previously granted usage permission.
    event AuthorizationRevoked(uint256 indexed tokenId, address indexed user);

    /// @notice Emitted when the canonical memory root for a token changes.
    event MemoryRootUpdated(uint256 indexed tokenId, bytes32 oldRoot, bytes32 newRoot);

    /// @notice Returns every intelligent-data slot attached to `tokenId`.
    function intelligentDatasOf(uint256 tokenId) external view returns (IntelligentData[] memory);

    /// @notice ERC-7857 transfer that requires off-chain re-encryption proofs.
    function iTransferFrom(
        address from,
        address to,
        uint256 tokenId,
        TransferValidityProof[] calldata proofs
    ) external;

    /// @notice Pay to be authorized to invoke the iNFT for `intentHash`.
    function authorizeUsage(uint256 tokenId, bytes32 intentHash) external payable;

    /// @notice Revoke a previously granted usage permission.
    function revokeAuthorization(uint256 tokenId, address user) external;

    /// @notice Returns true if `user` is owner OR has an active authorization.
    function isAuthorized(uint256 tokenId, address user) external view returns (bool);

    /// @notice Append a new intelligent-data slot to `tokenId`.
    function updateData(uint256 tokenId, bytes32 dataHash, string calldata dataDescription) external;

    /// @notice Update the canonical 0G Storage memory root for `tokenId`.
    function updateMemoryRoot(uint256 tokenId, bytes32 storageRoot) external;

    /// @notice Returns the raw capability manifest bytes for `tokenId`.
    function capabilities(uint256 tokenId) external view returns (bytes memory);

    /// @notice Returns the latest memory root for `tokenId`.
    function memoryRoot(uint256 tokenId) external view returns (bytes32);
}
