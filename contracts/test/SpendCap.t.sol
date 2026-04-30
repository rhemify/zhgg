// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SpendCap} from "../src/SpendCap.sol";

contract SpendCapTest is Test {
    SpendCap internal cap;

    address internal grantor = address(0x6A47);
    address internal account = address(0xA110C);
    address internal asset   = address(0xDA1);

    event CapGranted(address indexed account, address indexed asset, address indexed grantor,
        bytes32 permissionId, uint128 maxPerPeriod, uint64 periodLength, uint64 expiresAt);
    event CapSpent(address indexed account, address indexed asset, bytes32 permissionId, uint128 amount, uint128 remainingThisPeriod);
    event CapPeriodReset(address indexed account, address indexed asset, bytes32 permissionId, uint64 newPeriodStart);
    event CapRevoked(address indexed account, address indexed asset, address indexed revoker, bytes32 permissionId);

    function setUp() public {
        cap = new SpendCap();
    }

    // ----- grant -----

    function test_grant_emitsAndStoresCap() public {
        vm.prank(grantor);
        vm.expectEmit(true, true, true, true);
        emit CapGranted(account, asset, grantor, bytes32(0), 100e6, 1 days, 0);
        cap.grant(account, asset, 100e6, 1 days, 0);

        (uint128 max, uint128 remaining,,,, , address owner) = cap.capOf(account, asset);
        assertEq(max, 100e6);
        assertEq(remaining, 100e6);
        assertEq(owner, grantor);
    }

    function test_grant_rejectsZeroMax() public {
        vm.prank(grantor);
        vm.expectRevert(SpendCap.InvalidMax.selector);
        cap.grant(account, asset, 0, 1 days, 0);
    }

    function test_grant_rejectsZeroPeriod() public {
        vm.prank(grantor);
        vm.expectRevert(SpendCap.InvalidPeriod.selector);
        cap.grant(account, asset, 100, 0, 0);
    }

    function test_grant_thirdPartyUpdateReverts() public {
        vm.prank(grantor);
        cap.grant(account, asset, 100, 1 days, 0);
        vm.prank(address(0xDEAD));
        vm.expectRevert(SpendCap.NotCapOwner.selector);
        cap.grant(account, asset, 200, 1 days, 0);
    }

    // ----- spend -----

    function test_spend_decreasesRemaining() public {
        vm.prank(grantor);
        cap.grant(account, asset, 100, 1 days, 0);
        vm.prank(account);
        cap.spend(account, asset, 30);
        (, uint128 remaining,,,,,) = cap.capOf(account, asset);
        assertEq(remaining, 70);
    }

    function test_spend_revertsWhenExceeded() public {
        vm.prank(grantor);
        cap.grant(account, asset, 100, 1 days, 0);
        vm.prank(account);
        vm.expectRevert(abi.encodeWithSelector(SpendCap.CapExceeded.selector, uint128(101), uint128(100)));
        cap.spend(account, asset, 101);
    }

    function test_spend_callerMustBeAccount() public {
        vm.prank(grantor);
        cap.grant(account, asset, 100, 1 days, 0);
        vm.prank(address(0xDEAD));
        vm.expectRevert(SpendCap.NotAuthorizedSpender.selector);
        cap.spend(account, asset, 1);
    }

    function test_spend_periodRollsOver() public {
        vm.prank(grantor);
        cap.grant(account, asset, 100, 1 days, 0);
        vm.prank(account);
        cap.spend(account, asset, 100);

        // Cap exhausted in period 1.
        vm.prank(account);
        vm.expectRevert(abi.encodeWithSelector(SpendCap.CapExceeded.selector, uint128(1), uint128(0)));
        cap.spend(account, asset, 1);

        // Roll into next day.
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(account);
        cap.spend(account, asset, 50);
        (, uint128 remaining,,,,,) = cap.capOf(account, asset);
        assertEq(remaining, 50);
    }

    function test_spend_revertsWhenRevoked() public {
        vm.prank(grantor);
        cap.grant(account, asset, 100, 1 days, 0);
        vm.prank(grantor);
        cap.revoke(account, asset);
        vm.prank(account);
        vm.expectRevert(SpendCap.CapRevoked_.selector);
        cap.spend(account, asset, 1);
    }

    function test_spend_revertsWhenExpired() public {
        vm.prank(grantor);
        cap.grant(account, asset, 100, 1 days, uint64(block.timestamp + 100));
        vm.warp(block.timestamp + 200);
        vm.prank(account);
        vm.expectRevert(SpendCap.CapExpired.selector);
        cap.spend(account, asset, 1);
    }

    function test_spend_revertsWhenNoCap() public {
        vm.prank(account);
        vm.expectRevert(SpendCap.CapNotFound.selector);
        cap.spend(account, asset, 1);
    }

    // ----- ERC-7715 per-permission scoping -----
    //
    // Per the spec, an iNFT owner can grant DIFFERENT caps to different
    // workflows on the same (account, asset) pair — a low-stakes audit
    // workflow gets a small cap, a heavy market-making workflow gets a
    // larger one. They MUST be independent: spending the audit cap
    // can't drain the market-making cap.

    bytes32 constant AUDIT_PERM   = keccak256("zhgg.audit.v1");
    bytes32 constant ORACLE_PERM  = keccak256("zhgg.oracle.v1");

    function test_perPermission_grantsAreIndependent() public {
        vm.prank(grantor);
        cap.grantPermission(account, asset, AUDIT_PERM, 100, 1 days, 0);
        vm.prank(grantor);
        cap.grantPermission(account, asset, ORACLE_PERM, 50, 1 days, 0);

        (uint128 max1, uint128 rem1, , , , , ) =
            cap.permissionOf(account, asset, AUDIT_PERM);
        (uint128 max2, uint128 rem2, , , , , ) =
            cap.permissionOf(account, asset, ORACLE_PERM);

        assertEq(max1, 100);
        assertEq(rem1, 100);
        assertEq(max2, 50);
        assertEq(rem2, 50);
    }

    function test_perPermission_spendIsolated() public {
        vm.prank(grantor);
        cap.grantPermission(account, asset, AUDIT_PERM, 100, 1 days, 0);
        vm.prank(grantor);
        cap.grantPermission(account, asset, ORACLE_PERM, 50, 1 days, 0);

        // Drain the audit cap entirely.
        vm.prank(account);
        cap.spendPermission(account, asset, AUDIT_PERM, 100);

        // Audit cap is now 0/100; oracle cap should still be 50/50.
        (, uint128 auditRem, , , , , ) = cap.permissionOf(account, asset, AUDIT_PERM);
        (, uint128 oracleRem, , , , , ) = cap.permissionOf(account, asset, ORACLE_PERM);
        assertEq(auditRem, 0);
        assertEq(oracleRem, 50);

        // Oracle cap still works.
        vm.prank(account);
        cap.spendPermission(account, asset, ORACLE_PERM, 25);
        (, uint128 oracleRemAfter, , , , , ) = cap.permissionOf(account, asset, ORACLE_PERM);
        assertEq(oracleRemAfter, 25);
    }

    function test_perPermission_revokeIsolated() public {
        vm.prank(grantor);
        cap.grantPermission(account, asset, AUDIT_PERM, 100, 1 days, 0);
        vm.prank(grantor);
        cap.grantPermission(account, asset, ORACLE_PERM, 50, 1 days, 0);

        vm.prank(grantor);
        cap.revokePermission(account, asset, AUDIT_PERM);

        // Revoked permission rejects spend.
        vm.prank(account);
        vm.expectRevert(SpendCap.CapRevoked_.selector);
        cap.spendPermission(account, asset, AUDIT_PERM, 1);

        // Untouched permission still works.
        vm.prank(account);
        cap.spendPermission(account, asset, ORACLE_PERM, 10);
    }

    function test_perPermission_legacyApiUsesZeroPermissionId() public {
        // Old `grant` / `spend` / `capOf` continue to work — they
        // operate against `permissionId = bytes32(0)` so callers that
        // haven't migrated keep the same behavior. Confirm the legacy
        // bucket is independent of any explicit permission bucket.
        vm.prank(grantor);
        cap.grant(account, asset, 100, 1 days, 0);
        vm.prank(grantor);
        cap.grantPermission(account, asset, AUDIT_PERM, 30, 1 days, 0);

        vm.prank(account);
        cap.spend(account, asset, 100); // drains legacy bucket

        (, uint128 legacyRem, , , , , ) = cap.permissionOf(account, asset, bytes32(0));
        (, uint128 auditRem, , , , , ) = cap.permissionOf(account, asset, AUDIT_PERM);
        assertEq(legacyRem, 0);
        assertEq(auditRem, 30);
    }
}
