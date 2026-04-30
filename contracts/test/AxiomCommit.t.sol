// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AxiomCommit} from "../src/AxiomCommit.sol";

contract AxiomCommitTest is Test {
    AxiomCommit internal axiom;

    address internal alice = address(0xA11CE);
    address internal bob   = address(0xB0B);

    bytes internal constant PLAN   = bytes("swap 100 USDC -> ETH on Uniswap v3");
    bytes internal constant RESULT = bytes('{"txHash":"0xdeadbeef","ok":true}');

    event PlanCommitted(uint256 indexed tokenId, bytes32 indexed commitId, bytes32 planHash, address indexed committer, uint256 blockNumber);
    event PlanRevealed(uint256 indexed tokenId, bytes32 indexed commitId, bytes plan, bytes result);

    function setUp() public {
        axiom = new AxiomCommit();
    }

    function _planHash() internal pure returns (bytes32) {
        return keccak256(PLAN);
    }

    function _expectedCommitId(uint256 tokenId, address sender, uint256 blockNum) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(tokenId, keccak256(PLAN), sender, blockNum));
    }

    function test_commitPlan_storesCommitAndEmits() public {
        bytes32 expectedId = _expectedCommitId(1, alice, block.number);
        vm.expectEmit(true, true, true, true);
        emit PlanCommitted(1, expectedId, _planHash(), alice, block.number);
        vm.prank(alice);
        bytes32 id = axiom.commitPlan(1, _planHash());
        assertEq(id, expectedId);

        (address committer, uint64 bn, bool revealed, bytes32 ph) = axiom.commitOf(id);
        assertEq(committer, alice);
        assertEq(uint256(bn), block.number);
        assertEq(revealed, false);
        assertEq(ph, _planHash());
    }

    function test_commitPlan_isIdempotentInSameBlock() public {
        vm.prank(alice);
        bytes32 id1 = axiom.commitPlan(1, _planHash());
        vm.prank(alice);
        bytes32 id2 = axiom.commitPlan(1, _planHash());
        assertEq(id1, id2);
    }

    function test_commitPlan_distinctIdsAcrossBlocks() public {
        vm.prank(alice);
        bytes32 id1 = axiom.commitPlan(1, _planHash());
        vm.roll(block.number + 1);
        vm.prank(alice);
        bytes32 id2 = axiom.commitPlan(1, _planHash());
        assertTrue(id1 != id2);
    }

    function test_revealPlan_succeedsForCommitter() public {
        vm.prank(alice);
        bytes32 id = axiom.commitPlan(1, _planHash());

        vm.expectEmit(true, true, false, true);
        emit PlanRevealed(1, id, PLAN, RESULT);
        vm.prank(alice);
        axiom.revealPlan(1, id, PLAN, RESULT);

        (, , bool revealed, ) = axiom.commitOf(id);
        assertTrue(revealed);
    }

    function test_revealPlan_revertsIfNotCommitter() public {
        vm.prank(alice);
        bytes32 id = axiom.commitPlan(1, _planHash());
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AxiomCommit.NotCommitter.selector, id, bob));
        axiom.revealPlan(1, id, PLAN, RESULT);
    }

    function test_revealPlan_revertsOnPlanHashMismatch() public {
        vm.prank(alice);
        bytes32 id = axiom.commitPlan(1, _planHash());
        bytes memory wrong = bytes("different plan");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AxiomCommit.PlanHashMismatch.selector, keccak256(PLAN), keccak256(wrong)));
        axiom.revealPlan(1, id, wrong, RESULT);
    }

    function test_revealPlan_revertsOnDoubleReveal() public {
        vm.prank(alice);
        bytes32 id = axiom.commitPlan(1, _planHash());
        vm.prank(alice);
        axiom.revealPlan(1, id, PLAN, RESULT);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AxiomCommit.AlreadyRevealed.selector, id));
        axiom.revealPlan(1, id, PLAN, RESULT);
    }

    function test_revealPlan_revertsForUnknownCommit() public {
        bytes32 phantom = keccak256("nope");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AxiomCommit.CommitNotFound.selector, phantom));
        axiom.revealPlan(1, phantom, PLAN, RESULT);
    }

    function test_revealPlan_revertsOnEmptyPlan() public {
        vm.prank(alice);
        bytes32 id = axiom.commitPlan(1, _planHash());
        vm.prank(alice);
        vm.expectRevert(AxiomCommit.EmptyPlan.selector);
        axiom.revealPlan(1, id, "", RESULT);
    }
}
