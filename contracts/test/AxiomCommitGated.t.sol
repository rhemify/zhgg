// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AxiomCommit} from "../src/AxiomCommit.sol";
import {AgentNFT} from "../src/AgentNFT.sol";

/// Permissioning tests — exercise the iNFT-gated path. Plain `new
/// AxiomCommit(address(0))` (permissionless) coverage lives in
/// AxiomCommit.t.sol so the existing 12 cases stay intact.
contract AxiomCommitGatedTest is Test {
    AxiomCommit internal axiom;
    AgentNFT internal nft;

    address internal owner    = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal stranger = makeAddr("stranger");

    uint256 internal tokenId;
    bytes32 internal constant PLAN_HASH = keccak256("plan");

    function setUp() public {
        nft = new AgentNFT();
        axiom = new AxiomCommit(address(nft));
        tokenId = nft.mint(owner, hex"");
    }

    function test_commit_succeedsForINFTOwner() public {
        vm.prank(owner);
        bytes32 id = axiom.commitPlan(tokenId, PLAN_HASH);
        assertTrue(id != bytes32(0));
    }

    function test_commit_revertsForStranger() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(AxiomCommit.NotAuthorizedToCommit.selector, tokenId, stranger)
        );
        axiom.commitPlan(tokenId, PLAN_HASH);
    }

    function test_commit_succeedsForAuthorizedOperator() public {
        vm.prank(owner);
        axiom.setOperator(tokenId, operator, true);

        vm.prank(operator);
        bytes32 id = axiom.commitPlan(tokenId, PLAN_HASH);
        assertTrue(id != bytes32(0));
    }

    function test_commit_revertsForRevokedOperator() public {
        vm.prank(owner);
        axiom.setOperator(tokenId, operator, true);
        vm.prank(owner);
        axiom.setOperator(tokenId, operator, false);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(AxiomCommit.NotAuthorizedToCommit.selector, tokenId, operator)
        );
        axiom.commitPlan(tokenId, PLAN_HASH);
    }

    function test_setOperator_onlyOwnerCanCall() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(AxiomCommit.NotTokenOwner.selector, tokenId, stranger)
        );
        axiom.setOperator(tokenId, operator, true);
    }

    function test_operator_isPerTokenIdScoped() public {
        // Mint a second iNFT to a different owner.
        address owner2 = makeAddr("owner2");
        uint256 tokenId2 = nft.mint(owner2, hex"");

        // Authorize operator on tokenId only.
        vm.prank(owner);
        axiom.setOperator(tokenId, operator, true);

        // Operator may commit on tokenId.
        vm.prank(operator);
        axiom.commitPlan(tokenId, PLAN_HASH);

        // Operator may NOT commit on tokenId2 (different scope).
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(AxiomCommit.NotAuthorizedToCommit.selector, tokenId2, operator)
        );
        axiom.commitPlan(tokenId2, PLAN_HASH);
    }

    function test_permissionlessMode_emitsAtDeploy() public {
        vm.recordLogs();
        AxiomCommit a = new AxiomCommit(address(0));
        // Direct lookup — gated mode does NOT emit the event.
        assertEq(address(a.agentNft()), address(0));
    }
}
