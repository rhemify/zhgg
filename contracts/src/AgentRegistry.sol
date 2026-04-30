// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721URIStorage, ERC721} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

/// @title  AgentRegistry — minimal ERC-8004 adapter for 0G Galileo
/// @notice Identity Registry + Reputation Registry from ERC-8004. Validation
///         Registry is deferred to v2. Identity is an ERC-721 + URIStorage
///         per the EIP — agents are immediately browsable as NFTs.
/// @dev    The canonical 8004 contracts (vanity 0x8004A169...) are deployed
///         on Ethereum mainnet, Base, Sepolia, Base Sepolia, etc., but NOT
///         on 0G Galileo (chainId 16602). This is our adapter so receipts
///         can post on 0G Galileo. ABI-compatible with the canonical spec.
///
///         When the 8004 team publishes Galileo, we point our SDK rail at
///         the canonical address and retire this adapter. The agentURI
///         JSON file format is stable (per spec section 5.1).
///
///         Coupling with AgentNFT (ERC-7857): the iNFT lives in AgentNFT.sol,
///         the *passport* lives here. Each agent typically has BOTH — the
///         iNFT is the body, the AgentRegistry entry is the cross-platform
///         identity that accumulates receipts.
contract AgentRegistry is ERC721URIStorage {
    /// @notice Free-form metadata entry. The EIP suggests keys like
    ///         "inft" (ERC-7857 reference), "ens" (ENS name), "capabilities".
    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    /// @notice On-chain feedback record. Off-chain JSON is referenced by
    ///         `feedbackHash` (keccak256 of the file content).
    struct Feedback {
        int128 value;          // fixed-point feedback value (signed)
        uint8 valueDecimals;   // 0..18 decimals for the value
        string tag1;           // primary tag (e.g. "audit", "tradingYield")
        string tag2;           // secondary tag (e.g. "eu-ai-act")
        string endpoint;       // optional service endpoint that produced this work
        string feedbackURI;    // ipfs:// or https:// URI to the off-chain JSON
        bytes32 feedbackHash;  // keccak256(off-chain JSON) — integrity check
        bool isRevoked;
    }

    /// @notice Next agentId to assign. Starts at 1.
    uint256 public nextAgentId = 1;

    /// @notice Agent owner can delegate "agent wallet" — the address allowed
    ///         to act on behalf of the agent for off-chain proofs. Reset
    ///         to address(0) on every NFT transfer per spec.
    mapping(uint256 => address) private _agentWallet;

    /// @notice Per-agent metadata bag. Free-form keys.
    mapping(uint256 => mapping(string => bytes)) private _metadata;

    /// @notice Append-only feedback per (agentId, clientAddress).
    /// @dev    feedbackIndex is 1-based to match spec.
    mapping(uint256 => mapping(address => Feedback[])) private _feedback;

    /// @notice Track which clients have ever given feedback for an agent.
    mapping(uint256 => address[]) private _clients;
    mapping(uint256 => mapping(address => bool)) private _hasGivenFeedback;

    // ---------------------------------------------------------------------
    // Identity Registry events (per spec)
    // ---------------------------------------------------------------------

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    event MetadataSet(
        uint256 indexed agentId,
        string indexed indexedMetadataKey,
        string metadataKey,
        bytes metadataValue
    );

    // ---------------------------------------------------------------------
    // Reputation Registry events (per spec)
    // ---------------------------------------------------------------------

    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );
    event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex);

    error NotAgentOwner();
    error AgentNotFound();
    error SelfFeedbackForbidden();
    error InvalidFeedbackIndex();
    error AlreadyRevoked();
    error SignedSetAgentWalletNotImplemented();

    constructor() ERC721("zhgg AgentRegistry (ERC-8004)", "ZHGG-8004") {}

    // ---------------------------------------------------------------------
    // Identity Registry — register / update
    // ---------------------------------------------------------------------

    /// @notice Register a new agent with a URI and metadata bag.
    /// @param  agentURI  ipfs:// or https:// URI to the registration JSON.
    /// @param  metadata  Initial metadata entries (e.g. {"inft": "...", "ens": "..."}).
    /// @return agentId   Newly issued agentId.
    function register(string calldata agentURI, MetadataEntry[] calldata metadata)
        external
        returns (uint256 agentId)
    {
        agentId = nextAgentId;
        nextAgentId = agentId + 1;

        _safeMint(msg.sender, agentId);
        _setTokenURI(agentId, agentURI);
        emit Registered(agentId, agentURI, msg.sender);

        for (uint256 i = 0; i < metadata.length; i++) {
            _metadata[agentId][metadata[i].metadataKey] = metadata[i].metadataValue;
            emit MetadataSet(
                agentId,
                metadata[i].metadataKey,
                metadata[i].metadataKey,
                metadata[i].metadataValue
            );
        }
    }

    /// @notice Update an agent's URI. Owner only.
    function setAgentURI(uint256 agentId, string calldata newURI) external {
        if (_ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        _setTokenURI(agentId, newURI);
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    /// @notice Set or update a metadata entry. Owner only.
    function setMetadata(uint256 agentId, string calldata metadataKey, bytes calldata metadataValue) external {
        if (_ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        _metadata[agentId][metadataKey] = metadataValue;
        emit MetadataSet(agentId, metadataKey, metadataKey, metadataValue);
    }

    /// @notice Read a metadata entry.
    function getMetadata(uint256 agentId, string calldata metadataKey) external view returns (bytes memory) {
        return _metadata[agentId][metadataKey];
    }

    /// @notice Set the agent wallet — an address authorized to sign on
    ///         behalf of the agent off-chain.
    /// @dev    ABI-compatible with the canonical ERC-8004 Identity
    ///         Registry: accepts `(agentId, newWallet, deadline, signature)`.
    ///         The owner-only path (`signature.length == 0`) is the V1
    ///         minimal adapter — when the canonical 8004 deployment lands
    ///         on 0G Galileo we'll switch the SDK rail and the off-chain
    ///         signed-deadline path activates without an ABI change.
    ///         Off-chain signing path is intentionally NOT verified yet —
    ///         the function reverts so callers can't accidentally rely on
    ///         a signature that isn't checked.
    function setAgentWallet(
        uint256 agentId,
        address newWallet,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (signature.length == 0) {
            // V1 minimal adapter: owner-only direct set, no signature.
            // `deadline` is unused on this path.
            deadline; // silence unused-warning
            if (_ownerOf(agentId) != msg.sender) revert NotAgentOwner();
            _agentWallet[agentId] = newWallet;
            return;
        }
        // Off-chain-signed path: not implemented in V1. Revert loudly so
        // production callers know to wait for canonical 8004.
        revert SignedSetAgentWalletNotImplemented();
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return _agentWallet[agentId];
    }

    function unsetAgentWallet(uint256 agentId) external {
        if (_ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        _agentWallet[agentId] = address(0);
    }

    /// @dev Reset agent wallet on transfer per spec.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = super._update(to, tokenId, auth);
        if (from != address(0) && from != to) {
            _agentWallet[tokenId] = address(0);
        }
        return from;
    }

    // ---------------------------------------------------------------------
    // Reputation Registry — append / revoke / read
    // ---------------------------------------------------------------------

    /// @notice Submit feedback for an agent. msg.sender must NOT be the agent
    ///         owner (self-feedback is forbidden per spec).
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        address owner = _ownerOf(agentId);
        if (owner == address(0)) revert AgentNotFound();
        if (msg.sender == owner) revert SelfFeedbackForbidden();

        _feedback[agentId][msg.sender].push(
            Feedback({
                value: value,
                valueDecimals: valueDecimals,
                tag1: tag1,
                tag2: tag2,
                endpoint: endpoint,
                feedbackURI: feedbackURI,
                feedbackHash: feedbackHash,
                isRevoked: false
            })
        );

        if (!_hasGivenFeedback[agentId][msg.sender]) {
            _hasGivenFeedback[agentId][msg.sender] = true;
            _clients[agentId].push(msg.sender);
        }

        uint64 feedbackIndex = uint64(_feedback[agentId][msg.sender].length); // 1-based
        emit NewFeedback(
            agentId,
            msg.sender,
            feedbackIndex,
            value,
            valueDecimals,
            tag1,
            tag1,
            tag2,
            endpoint,
            feedbackURI,
            feedbackHash
        );
    }

    /// @notice Revoke previously-given feedback. Only the original client may revoke.
    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        Feedback[] storage list = _feedback[agentId][msg.sender];
        if (feedbackIndex == 0 || feedbackIndex > list.length) revert InvalidFeedbackIndex();
        Feedback storage fb = list[feedbackIndex - 1];
        if (fb.isRevoked) revert AlreadyRevoked();
        fb.isRevoked = true;
        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    /// @notice Read a single feedback entry.
    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (
            int128 value,
            uint8 valueDecimals,
            string memory tag1,
            string memory tag2,
            bool isRevoked
        )
    {
        Feedback memory fb = _feedback[agentId][clientAddress][feedbackIndex - 1];
        return (fb.value, fb.valueDecimals, fb.tag1, fb.tag2, fb.isRevoked);
    }

    /// @notice Read the feedback count for a (agent, client) pair.
    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64) {
        return uint64(_feedback[agentId][clientAddress].length);
    }

    /// @notice List all clients who have ever given feedback for an agent.
    /// @dev    UNSAFE for on-chain consumers — the array is unbounded and
    ///         can exceed block gas as feedback accumulates. Off-chain
    ///         indexers can use this safely; on-chain callers MUST use
    ///         `getClientsPaginated` + `getClientCount`.
    function getClients(uint256 agentId) external view returns (address[] memory) {
        return _clients[agentId];
    }

    /// @notice Number of distinct clients that have given feedback for `agentId`.
    function getClientCount(uint256 agentId) external view returns (uint256) {
        return _clients[agentId].length;
    }

    /// @notice Bounded view into the clients list. Always safe for on-chain
    ///         callers regardless of how much feedback the agent has
    ///         accumulated. Returns up to `limit` clients starting at
    ///         `offset`. Past-the-end returns an empty array; over-large
    ///         `limit` is clipped to what's available.
    function getClientsPaginated(uint256 agentId, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory page)
    {
        address[] storage clients = _clients[agentId];
        uint256 total = clients.length;
        if (offset >= total) {
            return new address[](0);
        }
        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 size = end - offset;
        page = new address[](size);
        for (uint256 i = 0; i < size; i++) {
            page[i] = clients[offset + i];
        }
    }
}
