// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  SpendCap — minimal ERC-7715-style spend cap manager
/// @notice Per-(account, asset, period) debit-style caps. The owner of an
///         account (typically an iNFT smart wallet) grants a cap; the
///         account's delegate redeems against it. Caps reset every period.
///         Reverts closed when exceeded — bounded blast radius if a key leaks.
/// @dev    This is a minimal implementation of the spend-cap *primitive* from
///         ERC-7715. We intentionally do NOT implement the full
///         `wallet_requestExecutionPermissions` JSON-RPC surface or
///         ERC-7710's `redeemDelegations` — that lives in the off-chain
///         delegation manager. This contract is the on-chain enforcement
///         leaf that any DelegationManager implementation can call.
///
///         Coupling with AgentNFT: the iNFT owner calls `grant()` to
///         authorize a per-iNFT spend cap. The iNFT's smart wallet calls
///         `spend()` before any outbound USDC transfer. If the cap is
///         exceeded, the wallet's tx reverts before the transfer fires.
contract SpendCap {
    /// @notice Per-cap state. Caps are keyed by (account, asset, periodLength).
    /// @dev    `consumed` resets to 0 the first time `spend` is called in a
    ///         new period (block.timestamp / periodLength).
    struct Cap {
        uint128 maxPerPeriod;     // max amount allowed per period (in asset's atomic units)
        uint128 consumed;          // amount consumed in the current period
        uint64  periodLength;      // period length in seconds (e.g. 86400 = daily)
        uint64  currentPeriodStart;// unix timestamp the current period started
        uint64  expiresAt;         // unix timestamp the cap expires (0 = never)
        bool    revoked;           // true if owner has revoked this cap
    }

    /// @notice Cap storage, keyed by `keccak256(account, asset)`.
    mapping(bytes32 => Cap) private _caps;

    /// @notice Per-account, per-asset owner. Set on first `grant`. Only
    ///         this address can revoke or update the cap.
    mapping(bytes32 => address) private _capOwner;

    /// @notice Emitted when a cap is granted or updated.
    event CapGranted(
        address indexed account,
        address indexed asset,
        address indexed grantor,
        uint128 maxPerPeriod,
        uint64 periodLength,
        uint64 expiresAt
    );

    /// @notice Emitted on every successful spend.
    event CapSpent(
        address indexed account,
        address indexed asset,
        uint128 amount,
        uint128 remainingThisPeriod
    );

    /// @notice Emitted when a period rolls over and `consumed` resets.
    event CapPeriodReset(
        address indexed account,
        address indexed asset,
        uint64 newPeriodStart
    );

    /// @notice Emitted when a cap is revoked by its owner.
    event CapRevoked(address indexed account, address indexed asset, address indexed revoker);

    error CapNotFound();
    error CapRevoked_();
    error CapExpired();
    error CapExceeded(uint128 requested, uint128 remaining);
    error NotCapOwner();
    error InvalidPeriod();
    error InvalidMax();

    // ---------------------------------------------------------------------
    // Grant / revoke
    // ---------------------------------------------------------------------

    /// @notice Grant or update a spend cap. Caller becomes the cap owner on
    ///         first grant; subsequent updates require the same caller.
    /// @param  account        The account whose spends are capped.
    /// @param  asset          ERC-20 token address (use `address(0)` for native).
    /// @param  maxPerPeriod   Maximum amount allowed per period.
    /// @param  periodLength   Period length in seconds. Must be > 0.
    /// @param  expiresAt      Unix timestamp. 0 = never expires.
    function grant(
        address account,
        address asset,
        uint128 maxPerPeriod,
        uint64 periodLength,
        uint64 expiresAt
    ) external {
        if (maxPerPeriod == 0) revert InvalidMax();
        if (periodLength == 0) revert InvalidPeriod();

        bytes32 key = _key(account, asset);
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

        emit CapGranted(account, asset, msg.sender, maxPerPeriod, periodLength, expiresAt);
    }

    /// @notice Revoke a cap. Only the cap owner can revoke.
    function revoke(address account, address asset) external {
        bytes32 key = _key(account, asset);
        if (_capOwner[key] != msg.sender) revert NotCapOwner();
        _caps[key].revoked = true;
        emit CapRevoked(account, asset, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Spend (the hot path — called before every outbound transfer)
    // ---------------------------------------------------------------------

    /// @notice Atomically debit `amount` against the cap for (account, asset).
    /// @dev    Reverts closed on any failure. Called by the account itself
    ///         (or its delegate) immediately before the actual transfer.
    ///         Period rollover happens automatically on the first spend
    ///         after a period boundary.
    /// @param  account  The capped account (must equal `msg.sender`).
    /// @param  asset    The asset being spent.
    /// @param  amount   Amount to debit.
    function spend(address account, address asset, uint128 amount) external {
        if (msg.sender != account) revert NotCapOwner();

        bytes32 key = _key(account, asset);
        Cap storage cap = _caps[key];

        if (cap.maxPerPeriod == 0) revert CapNotFound();
        if (cap.revoked) revert CapRevoked_();
        if (cap.expiresAt != 0 && block.timestamp > cap.expiresAt) revert CapExpired();

        // Roll over period if needed.
        uint64 nowTs = uint64(block.timestamp);
        if (nowTs >= cap.currentPeriodStart + cap.periodLength) {
            uint64 elapsedPeriods = (nowTs - cap.currentPeriodStart) / cap.periodLength;
            cap.currentPeriodStart = cap.currentPeriodStart + (elapsedPeriods * cap.periodLength);
            cap.consumed = 0;
            emit CapPeriodReset(account, asset, cap.currentPeriodStart);
        }

        uint128 remaining = cap.maxPerPeriod - cap.consumed;
        if (amount > remaining) revert CapExceeded(amount, remaining);

        cap.consumed += amount;
        emit CapSpent(account, asset, amount, cap.maxPerPeriod - cap.consumed);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Return current cap state, with period rollover applied virtually.
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
        bytes32 key = _key(account, asset);
        Cap memory cap = _caps[key];

        // Virtual rollover for view callers.
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

    function _key(address account, address asset) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(account, asset));
    }
}
