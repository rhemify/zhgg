// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OwnerMirror} from "../src/OwnerMirror.sol";

contract OwnerMirrorTest is Test {
    OwnerMirror internal mirror;

    address internal attestor = makeAddr("attestor");
    address internal alice    = makeAddr("alice");
    address internal bob      = makeAddr("bob");
    address internal carol    = makeAddr("carol");

    event OwnerSet(uint256 indexed tokenId, address indexed previous, address indexed current);
    event AttestorRotated(address indexed previous, address indexed current);

    function setUp() public {
        mirror = new OwnerMirror(attestor);
    }

    function test_constructor_revertsOnZeroAttestor() public {
        vm.expectRevert(OwnerMirror.ZeroAttestor.selector);
        new OwnerMirror(address(0));
    }

    function test_constructor_emitsRotated() public {
        vm.expectEmit(true, true, false, true);
        emit AttestorRotated(address(0), attestor);
        new OwnerMirror(attestor);
    }

    function test_ownerOf_revertsForUnmirroredToken() public {
        vm.expectRevert(abi.encodeWithSelector(OwnerMirror.TokenIdNotMirrored.selector, uint256(42)));
        mirror.ownerOf(42);
    }

    function test_setOwner_recordsAndEmits() public {
        vm.expectEmit(true, true, true, true);
        emit OwnerSet(42, address(0), alice);
        vm.prank(attestor);
        mirror.setOwner(42, alice);

        assertEq(mirror.ownerOf(42), alice);
        assertEq(uint256(mirror.lastUpdatedBlock(42)), block.number);
    }

    function test_setOwner_updatesPreviousFieldOnReassign() public {
        vm.prank(attestor);
        mirror.setOwner(42, alice);

        vm.expectEmit(true, true, true, true);
        emit OwnerSet(42, alice, bob);
        vm.prank(attestor);
        mirror.setOwner(42, bob);

        assertEq(mirror.ownerOf(42), bob);
    }

    function test_setOwner_revertsForNonAttestor() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnerMirror.NotAttestor.selector, alice));
        mirror.setOwner(42, alice);
    }

    function test_setOwnerBatch_appliesAll() public {
        uint256[] memory ids = new uint256[](3);
        address[] memory owners = new address[](3);
        ids[0] = 1; ids[1] = 2; ids[2] = 3;
        owners[0] = alice; owners[1] = bob; owners[2] = carol;

        vm.prank(attestor);
        mirror.setOwnerBatch(ids, owners);

        assertEq(mirror.ownerOf(1), alice);
        assertEq(mirror.ownerOf(2), bob);
        assertEq(mirror.ownerOf(3), carol);
    }

    function test_setOwnerBatch_revertsOnLengthMismatch() public {
        uint256[] memory ids = new uint256[](2);
        address[] memory owners = new address[](1);
        vm.prank(attestor);
        vm.expectRevert();
        mirror.setOwnerBatch(ids, owners);
    }

    function test_rotateAttestor_changesAuthorizedCaller() public {
        vm.prank(attestor);
        mirror.rotateAttestor(alice);
        assertEq(mirror.attestor(), alice);

        // Old attestor can no longer write.
        vm.prank(attestor);
        vm.expectRevert(abi.encodeWithSelector(OwnerMirror.NotAttestor.selector, attestor));
        mirror.setOwner(1, bob);

        // New attestor can.
        vm.prank(alice);
        mirror.setOwner(1, bob);
    }

    function test_rotateAttestor_revertsForNonAttestor() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnerMirror.NotAttestor.selector, alice));
        mirror.rotateAttestor(bob);
    }

    function test_rotateAttestor_revertsOnZeroAddress() public {
        vm.prank(attestor);
        vm.expectRevert(OwnerMirror.ZeroAttestor.selector);
        mirror.rotateAttestor(address(0));
    }

    function test_ownershipFreshness_returnsBlockTracking() public {
        // Roll to a known block so the assertion is deterministic
        // regardless of Foundry's starting `block.number`.
        vm.roll(1_000);
        vm.prank(attestor);
        mirror.setOwner(42, alice);
        (, uint64 lastBlockAtFirstWrite) = mirror.ownershipFreshness(42);
        assertEq(uint256(lastBlockAtFirstWrite), 1_000);

        vm.roll(1_100);
        vm.prank(attestor);
        mirror.setOwner(42, bob);

        (address currentOwner, uint64 lastBlock) = mirror.ownershipFreshness(42);
        assertEq(currentOwner, bob);
        assertEq(uint256(lastBlock), 1_100);
    }

    function test_setOwner_idempotentOnSameOwner() public {
        vm.roll(2_000);
        vm.prank(attestor);
        mirror.setOwner(42, alice);

        vm.roll(2_050);
        vm.prank(attestor);
        mirror.setOwner(42, alice);

        // Owner unchanged but lastUpdatedBlock advanced — staleness probe.
        (address currentOwner, uint64 lastBlock) = mirror.ownershipFreshness(42);
        assertEq(currentOwner, alice);
        assertEq(uint256(lastBlock), 2_050);
    }
}
