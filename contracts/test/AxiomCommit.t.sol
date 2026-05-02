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
        // Permissionless mode (agentNft = 0) preserves the existing
        // test surface; iNFT-gated tests live in AxiomCommitGated.t.sol.
        axiom = new AxiomCommit(address(0));
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

    function test_revealPlan_revertsOnOversizedPlan() public {
        // Block-gas-limit defense. `bytes plan` is non-indexed in the
        // emitted event so unbounded reveals can blow past the
        // ~30M-gas-on-mainnet ceiling. Cap at MAX_PLAN_SIZE (8KB).
        // Cache constant locally — public-constant getters are external
        // calls and would consume `vm.prank` before `revealPlan` fires.
        uint256 max = axiom.MAX_PLAN_SIZE();
        bytes memory big = new bytes(max + 1);
        bytes32 bigHash = keccak256(big);
        vm.prank(alice);
        bytes32 id = axiom.commitPlan(1, bigHash);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(AxiomCommit.PlanTooLarge.selector, max + 1, max)
        );
        axiom.revealPlan(1, id, big, RESULT);
    }

    function test_revealPlan_revertsOnOversizedResult() public {
        uint256 max = axiom.MAX_PLAN_SIZE();
        vm.prank(alice);
        bytes32 id = axiom.commitPlan(1, _planHash());
        bytes memory bigResult = new bytes(max + 1);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(AxiomCommit.ResultTooLarge.selector, max + 1, max)
        );
        axiom.revealPlan(1, id, PLAN, bigResult);
    }

    function test_revealPlan_acceptsExactlyMaxSize() public {
        // Just under the cap must work; cap is inclusive of the limit.
        uint256 max = axiom.MAX_PLAN_SIZE();
        bytes memory atMax = new bytes(max);
        // Set first byte non-zero so keccak doesn't accidentally collide
        // across runs with another zero-bytes plan.
        atMax[0] = 0x42;
        bytes32 atMaxHash = keccak256(atMax);
        vm.prank(alice);
        bytes32 id = axiom.commitPlan(1, atMaxHash);
        vm.prank(alice);
        axiom.revealPlan(1, id, atMax, RESULT);

        (, , bool revealed, ) = axiom.commitOf(id);
        assertTrue(revealed);
    }

    /// SOL↔TS parity: locks the on-chain commitId derivation against a
    /// fixture hardcoded in `apps/demo/test/loop-helpers.test.ts`. Any
    /// drift between the Solidity `abi.encodePacked` and viem's
    /// `encodePacked` (case folding, length padding, type widths) flips
    /// this assertion.
    function test_commitId_matches_ts_parity_fixture() public {
        bytes memory parityPlan = bytes("test plan");
        bytes32 parityPlanHash = keccak256(parityPlan);
        address paritySender = 0xcA11E7c00Ffe5c0De0000000000000000000beeF;
        uint256 parityBlock = 100;

        // Fixture target — must equal the AXIOM_COMMIT_ID constant in the
        // TS test. If you change inputs here, update both sides.
        bytes32 expected = 0xf69605a66ee37a6f57d5c0857e158a5f0771b3fd2bd8562d8dbc6239a0258d4d;

        bytes32 actual = keccak256(
            abi.encodePacked(uint256(42), parityPlanHash, paritySender, parityBlock)
        );
        assertEq(actual, expected, "SOL commitId drift from TS fixture");

        // Also verify the contract produces the same hash from the same
        // inputs by rolling block + prank to match.
        vm.roll(parityBlock);
        vm.prank(paritySender);
        bytes32 contractId = axiom.commitPlan(42, parityPlanHash);
        assertEq(contractId, expected, "AxiomCommit.commitPlan drift");
    }
}
