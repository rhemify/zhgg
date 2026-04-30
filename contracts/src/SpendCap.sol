// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  SpendCap — minimal ERC-7715-style spend cap manager
/// @notice Per-(account, asset, permissionId, period) debit-style caps.
///         The owner of an account (typically an iNFT smart wallet)
///         grants a cap; the account's delegate redeems against it.
///         Caps reset every period. Reverts closed when exceeded —
///         bounded blast radius if a key leaks.
/// @dev    Implements the ERC-7715 spend-cap *primitive*. The
///         `permissionId` field scopes a cap to a specific permission
///         bundle (e.g. one workflow's `inft-spend-cap` is independent
///         of another's). `permissionId == bytes32(0)` is the default
///         bucket used by the legacy `grant` / `spend` / `revoke` /
///         `capOf` API; new callers should use the `*Permission`
///         variants with a content-derived `bytes32 permissionId`
///         (e.g. `keccak256("zhgg.audit.v1")`) to avoid cross-workflow
///         contention.
///
///         We intentionally do NOT implement the full
///         `wallet_requestExecutionPermissions` JSON-RPC surface or
///         ERC-7710's `redeemDelegations` — that lives in the off-chain
///         delegation manager. This contract is the on-chain
///         enforcement leaf any DelegationManager implementation can
///         call.
contract SpendCap {
    /// @notice Per-cap state. Caps are keyed by
    ///         `keccak256(account, asset, permissionId)`.
    /// @dev    `consumed` resets to 0 the first time `spend` is called
    ///         in a new period (block.timestamp / periodLength).
    struct Cap {
        uint128 maxPerPeriod;     // max amount allowed per period (in asset's atomic units)
        uint128 consumed;          // amount consumed in the current period
        uint64  periodLength;      // period length in seconds (e.g. 86400 = daily)
        uint64  currentPeriodStart;// unix timestamp the current period started
        uint64  expiresAt;         // unix timestamp the cap expires (0 = never)
        bool    revoked;           // true if owner has revoked this cap
    }

    mapping(bytes32 => Cap) private _caps;
    mapping(bytes32 => address) private _capOwner;

    event CapGranted(
        address indexed account,
        address indexed asset,
        address indexed grantor,
        bytes32 permissionId,
        uint128 maxPerPeriod,
        uint64 periodLength,
        uint64 expiresAt
    );

    event CapSpent(
        address indexed account,
        address indexed asset,
        bytes32 permissionId,
        uint128 amount,
        uint128 remainingThisPeriod
    );

    event CapPeriodReset(
        address indexed account,
        address indexed asset,
        bytes32 permissionId,
        uint64 newPeriodStart
    );

    event CapRevoked(
        address indexed account,
        address indexed asset,
        address indexed revoker,
        bytes32 permissionId
    );

    error CapNotFound();
    error CapRevoked_();
    error CapExpired();
    error CapExceeded(uint128 requested, uint128 remaining);
    error NotCapOwner();
    error NotAuthorizedSpender();
    error InvalidPeriod();
    error InvalidMax();

    // ---------------------------------------------------------------------
    // Per-permission API (ERC-7715-aligned)
    // ---------------------------------------------------------------------

    function grantPermission(
        address account,
        address asset,
        bytes32 permissionId,
        uint128 maxPerPeriod,
        uint64 periodLength,
        uint64 expiresAt
    ) public {
        if (maxPerPeriod == 0) revert InvalidMax();
        if (periodLength == 0) revert InvalidPeriod();

        bytes32 key = _key(account, asset, permissionId);
        address existingOwner = _capOwner[key];
        if (existingOwner == address(0)) {
            _capOwner[key] = msg.sender;
        } else if (existingOwner != msg.sender) {
            revert NotCapOwner();
        }

        _caps[key] = Cap({
            maxPerPeriod: maxPerPeriod,
            consumed: 0,
            periodLength: periodLength,
            currentPeriodStart: uint64(block.timestamp),
            expiresAt: expiresAt,
            revoked: false
        });

        emit CapGranted(account, asset, msg.sender, permissionId, maxPerPeriod, periodLength, expiresAt);
    }

    function revokePermission(address account, address asset, bytes32 permissionId) public {
        bytes32 key = _key(account, asset, permissionId);
        if (_capOwner[key] != msg.sender) revert NotCapOwner();
        _caps[key].revoked = true;
        emit CapRevoked(account, asset, msg.sender, permissionId);
    }

    function spendPermission(
        address account,
        address asset,
        bytes32 permissionId,
        uint128 amount
    ) public {
        if (msg.sender != account) revert NotAuthorizedSpender();

        bytes32 key = _key(account, asset, permissionId);
        Cap storage cap = _caps[key];

        if (cap.maxPerPeriod == 0) revert CapNotFound();
        if (cap.revoked) revert CapRevoked_();
        if (cap.expiresAt != 0 && block.timestamp > cap.expiresAt) revert CapExpired();

        uint64 nowTs = uint64(block.timestamp);
        if (nowTs >= cap.currentPeriodStart + cap.periodLength) {
            uint64 elapsedPeriods = (nowTs - cap.currentPeriodStart) / cap.periodLength;
            cap.currentPeriodStart = cap.currentPeriodStart + (elapsedPeriods * cap.periodLength);
            cap.consumed = 0;
            emit CapPeriodReset(account, asset, permissionId, cap.currentPeriodStart);
        }

        uint128 remaining = cap.maxPerPeriod - cap.consumed;
        if (amount > remaining) revert CapExceeded(amount, remaining);

        cap.consumed += amount;
        emit CapSpent(account, asset, permissionId, amount, cap.maxPerPeriod - cap.consumed);
    }

    function permissionOf(address account, address asset, bytes32 permissionId)
        public
        view
        returns (
            uint128 maxPerPeriod,
            uint128 remaining,
            uint64 periodLength,
            uint64 currentPeriodStart,
            uint64 expiresAt,
            bool revoked,
            address owner
        )
    {
        bytes32 key = _key(account, asset, permissionId);
        Cap memory cap = _caps[key];

        uint64 nowTs = uint64(block.timestamp);
        uint128 effectiveConsumed = cap.consumed;
        uint64 effectivePeriodStart = cap.currentPeriodStart;
        if (cap.periodLength > 0 && nowTs >= cap.currentPeriodStart + cap.periodLength) {
            uint64 elapsedPeriods = (nowTs - cap.currentPeriodStart) / cap.periodLength;
            effectivePeriodStart = cap.currentPeriodStart + (elapsedPeriods * cap.periodLength);
            effectiveConsumed = 0;
        }

        maxPerPeriod = cap.maxPerPeriod;
        remaining = cap.maxPerPeriod >= effectiveConsumed ? cap.maxPerPeriod - effectiveConsumed : 0;
        periodLength = cap.periodLength;
        currentPeriodStart = effectivePeriodStart;
        expiresAt = cap.expiresAt;
        revoked = cap.revoked;
        owner = _capOwner[key];
    }

    // ---------------------------------------------------------------------
    // Legacy API — operates on `permissionId == bytes32(0)`
    // ---------------------------------------------------------------------

    /// @notice Grant or update a default-bucket spend cap.
    /// @dev    Equivalent to `grantPermission` with `permissionId =
    ///         bytes32(0)`. Kept for backward compatibility with
    ///         callers that haven't migrated to per-workflow scoping.
    function grant(
        address account,
        address asset,
        uint128 maxPerPeriod,
        uint64 periodLength,
        uint64 expiresAt
    ) external {
        grantPermission(account, asset, bytes32(0), maxPerPeriod, periodLength, expiresAt);
    }

    function revoke(address account, address asset) external {
        revokePermission(account, asset, bytes32(0));
    }

    function spend(address account, address asset, uint128 amount) external {
        spendPermission(account, asset, bytes32(0), amount);
    }

    function capOf(address account, address asset)
        external
        view
        returns (
            uint128 maxPerPeriod,
            uint128 remaining,
            uint64 periodLength,
            uint64 currentPeriodStart,
            uint64 expiresAt,
            bool revoked,
            address owner
        )
    {
        return permissionOf(account, asset, bytes32(0));
    }

    function _key(address account, address asset, bytes32 permissionId)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(account, asset, permissionId));
    }
}
