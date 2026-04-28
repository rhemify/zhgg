// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC7857} from "./interfaces/IERC7857.sol";

/// @title  AgentNFT — ERC-7857 intelligent NFT for zhgg agents
/// @notice An ERC-721 token where each tokenId represents an autonomous
///         agent. The on-chain record holds:
///         (1) a list of `IntelligentData` slots pointing at encrypted
///             blobs on 0G Storage (model weights, system prompt, etc.),
///         (2) a `memoryRoot` pointing at the latest agent memory commit,
///         (3) a `capabilityManifest` describing which tools / intents the
///             agent is allowed to invoke.
///         Third parties can `authorizeUsage` by paying a royalty to the
///         owner and quoting the keccak256 of the intent they intend to
///         execute. The audit log on `packages/router/src/audit.ts` uses
///         the same hashing convention.
/// @dev    v1 deliberately stubs ZK / TEE proof verification on
///         `iTransferFrom` — any non-empty `TransferValidityProof[]` is
///         accepted. Real verification ships in v2 alongside the 0G
///         re-encryption pipeline. The plain ERC-721 `transferFrom` and
///         `safeTransferFrom` overloads are disabled to force the iNFT
///         transfer flow.
contract AgentNFT is ERC721, ReentrancyGuard, IERC7857 {
    /// @notice Default royalty paid to the iNFT owner on `authorizeUsage`,
    ///         expressed in basis points (500 = 5%).
    uint96 public constant DEFAULT_ROYALTY_BPS = 500;

    /// @notice Denominator for basis-point math.
    uint96 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Next tokenId to assign. Starts at 1 — id 0 is reserved as
    ///         the "invalid / unset" sentinel across the codebase.
    uint256 public nextTokenId = 1;

    /// @dev Per-token append-only list of intelligent-data slots.
    mapping(uint256 => IntelligentData[]) private _intelligentDatas;

    /// @dev Per-token current memory root (0G Storage commitment).
    mapping(uint256 => bytes32) private _memoryRoot;

    /// @dev Per-token capability manifest bytes (opaque to the contract).
    mapping(uint256 => bytes) private _capabilityManifest;

    /// @dev Per-token usage authorizations granted to third parties.
    mapping(uint256 => mapping(address => bool)) private _authorizations;

    /// @dev Per-token royalty in basis points. Zero means "use default".
    mapping(uint256 => uint96) private _royaltyBps;

    /// @notice Reverts when the caller is not the owner of `tokenId`.
    error NotTokenOwner(uint256 tokenId, address caller);

    /// @notice Reverts when a payable refund to `msg.sender` fails.
    error RefundFailed();

    /// @notice Reverts when a royalty payout to the owner fails.
    error RoyaltyPayoutFailed();

    /// @notice Reverts when `iTransferFrom` is called with no proofs.
    error MissingTransferProofs();

    /// @notice Reverts when a non-iNFT transfer entrypoint is invoked.
    error TransferDisabled();

    /// @notice Emitted when iTransferFrom executes via the v1 stub path
    ///         (i.e. without TEE/ZK proof verification). Off-chain monitors
    ///         should treat this as a signal that v2 verification is bypassed.
    event TransferProofStubbed(uint256 indexed tokenId, address indexed caller);

    constructor() ERC721("zhgg Agent", "ZHGG-AGENT") {}

    // ---------------------------------------------------------------------
    // Mint
    // ---------------------------------------------------------------------

    /// @notice Mint a fresh iNFT. Open in v1 — production gates this.
    /// @param  owner               Recipient of the new token.
    /// @param  capabilityManifest  Opaque manifest bytes; consumed by the
    ///                             off-chain router / TUI.
    /// @return tokenId             Newly minted token id (starts at 1).
    function mint(address owner, bytes calldata capabilityManifest) external returns (uint256 tokenId) {
        tokenId = nextTokenId;
        nextTokenId = tokenId + 1;
        _capabilityManifest[tokenId] = capabilityManifest;
        _safeMint(owner, tokenId);
    }

    // ---------------------------------------------------------------------
    // Authorization
    // ---------------------------------------------------------------------

    /// @notice Pay to be authorized to invoke `tokenId` for `intentHash`.
    /// @dev    Royalty = `msg.value * DEFAULT_ROYALTY_BPS / BPS_DENOMINATOR`,
    ///         capped at `msg.value`. The remainder is refunded to the
    ///         caller via a low-level call. Reverts if the token does not
    ///         exist (delegated to `_requireOwned`).
    /// @param  tokenId     Target iNFT.
    /// @param  intentHash  keccak256 of the intent JSON the caller plans
    ///                     to execute (mirrors `audit.ts`).
    function authorizeUsage(uint256 tokenId, bytes32 intentHash) external payable nonReentrant {
        address owner = _requireOwned(tokenId);

        uint256 royaltyPaid = (msg.value * DEFAULT_ROYALTY_BPS) / BPS_DENOMINATOR;
        if (royaltyPaid > msg.value) {
            royaltyPaid = msg.value;
        }
        uint256 refund = msg.value - royaltyPaid;

        _authorizations[tokenId][msg.sender] = true;

        if (royaltyPaid > 0) {
            (bool okPay, ) = payable(owner).call{value: royaltyPaid}("");
            if (!okPay) {
                revert RoyaltyPayoutFailed();
            }
        }
        if (refund > 0) {
            (bool okRefund, ) = payable(msg.sender).call{value: refund}("");
            if (!okRefund) {
                revert RefundFailed();
            }
        }

        emit UsageAuthorized(tokenId, msg.sender, intentHash, royaltyPaid);
    }

    /// @notice Revoke a previously granted usage permission. Owner only.
    /// @param  tokenId  Target iNFT.
    /// @param  user     Address to deauthorize.
    function revokeAuthorization(uint256 tokenId, address user) external {
        address owner = _requireOwned(tokenId);
        if (msg.sender != owner) {
            revert NotTokenOwner(tokenId, msg.sender);
        }
        _authorizations[tokenId][user] = false;
        emit AuthorizationRevoked(tokenId, user);
    }

    /// @notice True if `user` is the token owner OR has an active grant.
    function isAuthorized(uint256 tokenId, address user) external view returns (bool) {
        address owner = _ownerOf(tokenId);
        if (owner == address(0)) {
            return false;
        }
        if (user == owner) {
            return true;
        }
        return _authorizations[tokenId][user];
    }

    // ---------------------------------------------------------------------
    // Data / state mutators (owner only)
    // ---------------------------------------------------------------------

    /// @notice Append a new intelligent-data slot to `tokenId`. Owner only.
    function updateData(uint256 tokenId, bytes32 dataHash, string calldata dataDescription) external {
        address owner = _requireOwned(tokenId);
        if (msg.sender != owner) {
            revert NotTokenOwner(tokenId, msg.sender);
        }
        _intelligentDatas[tokenId].push(IntelligentData({dataHash: dataHash, dataDescription: dataDescription}));
        emit IntelligentDataUpdated(tokenId, dataHash, dataDescription);
    }

    /// @notice Update the canonical 0G Storage memory root. Owner only.
    function updateMemoryRoot(uint256 tokenId, bytes32 storageRoot) external {
        address owner = _requireOwned(tokenId);
        if (msg.sender != owner) {
            revert NotTokenOwner(tokenId, msg.sender);
        }
        bytes32 oldRoot = _memoryRoot[tokenId];
        _memoryRoot[tokenId] = storageRoot;
        emit MemoryRootUpdated(tokenId, oldRoot, storageRoot);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Return every intelligent-data slot for `tokenId`.
    function intelligentDatasOf(uint256 tokenId) external view returns (IntelligentData[] memory) {
        return _intelligentDatas[tokenId];
    }

    /// @notice Return the raw capability manifest bytes for `tokenId`.
    function capabilities(uint256 tokenId) external view returns (bytes memory) {
        return _capabilityManifest[tokenId];
    }

    /// @notice Return the latest memory root for `tokenId`.
    function memoryRoot(uint256 tokenId) external view returns (bytes32) {
        return _memoryRoot[tokenId];
    }

    // ---------------------------------------------------------------------
    // ERC-7857 transfer flow
    // ---------------------------------------------------------------------

    /// @notice Transfer an iNFT after off-chain re-encryption proofs were
    ///         produced. v1 accepts any non-empty `proofs` array; real
    ///         verification (ZK / TEE attestation) lands in v2.
    /// @dev    Mirrors the auth checks of ERC-721 `safeTransferFrom`: the
    ///         caller must be the owner, an approved address, or an
    ///         operator-for-all.
    function iTransferFrom(
        address from,
        address to,
        uint256 tokenId,
        TransferValidityProof[] calldata proofs
    ) external nonReentrant {
        if (proofs.length == 0) {
            revert MissingTransferProofs();
        }
        // v1 stub guard: any approved party could pass a fake proof to bypass
        // the standard's TEE/ZK verifier. Until v2 ships real proof validation,
        // restrict to self-transfers (owner pulling their own iNFT). This blocks
        // the approval-bypass attack while keeping the v2 ABI unchanged.
        // Emits TransferProofStubbed so monitors can grep for v1-path transfers.
        if (msg.sender != from) {
            revert TransferDisabled();
        }
        emit TransferProofStubbed(tokenId, msg.sender);

        address previousOwner = _update(to, tokenId, msg.sender);
        if (previousOwner != from) {
            // Reuse the standard ERC-721 mismatch error for tooling parity.
            revert ERC721IncorrectOwner(from, tokenId, previousOwner);
        }
    }

    /// @notice Disabled. Use `iTransferFrom`.
    function transferFrom(address, address, uint256) public pure override {
        revert TransferDisabled();
    }

    /// @notice Disabled. Use `iTransferFrom`.
    function safeTransferFrom(address, address, uint256, bytes memory) public pure override {
        revert TransferDisabled();
    }
}
