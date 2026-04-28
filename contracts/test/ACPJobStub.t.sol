// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ACPJobStub} from "../src/ACPJobStub.sol";

/// @notice Behavioural tests for ACPJobStub covering the single-tx job lifecycle.
contract ACPJobStubTest is Test {
    ACPJobStub internal acp;

    address internal requester = address(0xA11CE);
    address internal agent = address(0xB0B);
    address internal stranger = address(0xC0FFEE);

    bytes32 internal constant INTENT = keccak256("intent");
    bytes32 internal constant RESPONSE = keccak256("response");

    // Mirror events for vm.expectEmit checks.
    event JobCreated(
        uint256 indexed id,
        address indexed requester,
        address indexed agent,
        uint256 budget,
        bytes32 intentHash
    );
    event JobSubmitted(uint256 indexed id, bytes32 responseHash);
    event JobCompleted(uint256 indexed id, address indexed agent, uint256 payout);
    event JobCancelled(uint256 indexed id, address indexed requester, uint256 refund);

    function setUp() public {
        acp = new ACPJobStub();
        vm.deal(requester, 100 ether);
        vm.deal(stranger, 10 ether);
    }

    // ---------- Helpers ----------

    function _create(uint256 budget) internal returns (uint256 id) {
        vm.prank(requester);
        id = acp.createJob{value: budget}(agent, INTENT);
    }

    // ---------- createJob ----------

    /// @notice Test 1: createJob with msg.value=0 reverts.
    function test_createJob_revertsOnZeroBudget() public {
        vm.prank(requester);
        vm.expectRevert(bytes("ACPJobStub: budget is zero"));
        acp.createJob{value: 0}(agent, INTENT);
    }

    /// @notice Test 2: createJob with agent=address(0) reverts.
    function test_createJob_revertsOnZeroAgent() public {
        vm.prank(requester);
        vm.expectRevert(bytes("ACPJobStub: agent is zero"));
        acp.createJob{value: 1 ether}(address(0), INTENT);
    }

    /// @notice Test 3: createJob assigns id starting at 1, then 2, then 3.
    function test_createJob_idStartsAtOneAndIncrements() public {
        uint256 id1 = _create(1 ether);
        uint256 id2 = _create(1 ether);
        uint256 id3 = _create(1 ether);
        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(id3, 3);
    }

    /// @notice Test 4: createJob stores all fields correctly.
    function test_createJob_storesFields() public {
        uint256 budget = 2 ether;
        uint256 id = _create(budget);

        ACPJobStub.Job memory job = acp.getJob(id);
        assertEq(job.agent, agent);
        assertEq(job.requester, requester);
        assertEq(job.budget, budget);
        assertEq(uint8(job.state), uint8(ACPJobStub.State.Funded));
        assertEq(job.intentHash, INTENT);
        assertEq(job.responseHash, bytes32(0));
        assertEq(uint256(job.createdAt), block.timestamp);
        assertEq(uint256(job.completedAt), 0);
    }

    /// @notice Test 5: createJob increments nextJobId.
    function test_createJob_incrementsNextJobId() public {
        assertEq(acp.nextJobId(), 0);
        _create(1 ether);
        assertEq(acp.nextJobId(), 1);
        _create(1 ether);
        assertEq(acp.nextJobId(), 2);
    }

    /// @notice Test 6: createJob updates totalEscrow.
    function test_createJob_updatesTotalEscrow() public {
        assertEq(acp.totalEscrow(), 0);
        _create(1 ether);
        assertEq(acp.totalEscrow(), 1 ether);
        _create(3 ether);
        assertEq(acp.totalEscrow(), 4 ether);
    }

    /// @notice Test 7: createJob emits JobCreated with correct args.
    function test_createJob_emitsJobCreated() public {
        vm.expectEmit(true, true, true, true, address(acp));
        emit JobCreated(1, requester, agent, 1 ether, INTENT);
        vm.prank(requester);
        acp.createJob{value: 1 ether}(agent, INTENT);
    }

    // ---------- submitResult ----------

    /// @notice Test 8: submitResult by non-agent reverts.
    function test_submitResult_revertsForNonAgent() public {
        uint256 id = _create(1 ether);
        vm.prank(stranger);
        vm.expectRevert(bytes("ACPJobStub: not agent"));
        acp.submitResult(id, RESPONSE);
        vm.prank(requester);
        vm.expectRevert(bytes("ACPJobStub: not agent"));
        acp.submitResult(id, RESPONSE);
    }

    /// @notice Test 9: submitResult on non-Funded states reverts.
    /// @dev Covers: never-created (Open default), already Submitted, Completed, Cancelled.
    function test_submitResult_revertsOnWrongStates() public {
        // Default Open (id never created): agent check fails first because job.agent is zero
        // and msg.sender is non-zero. Use a fresh id and prank the zero agent path below
        // via a state-only check on a real job.

        // Already Submitted -> revert wrong state.
        uint256 id1 = _create(1 ether);
        vm.prank(agent);
        acp.submitResult(id1, RESPONSE);
        vm.prank(agent);
        vm.expectRevert(bytes("ACPJobStub: wrong state"));
        acp.submitResult(id1, RESPONSE);

        // Completed -> revert wrong state.
        vm.prank(agent);
        acp.completeJob(id1);
        vm.prank(agent);
        vm.expectRevert(bytes("ACPJobStub: wrong state"));
        acp.submitResult(id1, RESPONSE);

        // Cancelled -> revert wrong state.
        uint256 id2 = _create(1 ether);
        vm.prank(requester);
        acp.cancelJob(id2);
        vm.prank(agent);
        vm.expectRevert(bytes("ACPJobStub: wrong state"));
        acp.submitResult(id2, RESPONSE);

        // Open (never-created id): agent guard fires first; the storage default agent is
        // address(0), so any non-zero caller trips "not agent".
        uint256 ghostId = 999;
        vm.prank(agent);
        vm.expectRevert(bytes("ACPJobStub: not agent"));
        acp.submitResult(ghostId, RESPONSE);
    }

    /// @notice Test 10: submitResult sets responseHash and transitions to Submitted.
    function test_submitResult_setsHashAndTransitions() public {
        uint256 id = _create(1 ether);
        vm.prank(agent);
        acp.submitResult(id, RESPONSE);

        ACPJobStub.Job memory job = acp.getJob(id);
        assertEq(job.responseHash, RESPONSE);
        assertEq(uint8(job.state), uint8(ACPJobStub.State.Submitted));
    }

    /// @notice Test 11: submitResult emits JobSubmitted.
    function test_submitResult_emitsJobSubmitted() public {
        uint256 id = _create(1 ether);
        vm.expectEmit(true, false, false, true, address(acp));
        emit JobSubmitted(id, RESPONSE);
        vm.prank(agent);
        acp.submitResult(id, RESPONSE);
    }

    // ---------- completeJob ----------

    /// @notice Test 12: completeJob by non-agent reverts.
    function test_completeJob_revertsForNonAgent() public {
        uint256 id = _create(1 ether);
        vm.prank(agent);
        acp.submitResult(id, RESPONSE);

        vm.prank(stranger);
        vm.expectRevert(bytes("ACPJobStub: not agent"));
        acp.completeJob(id);
        vm.prank(requester);
        vm.expectRevert(bytes("ACPJobStub: not agent"));
        acp.completeJob(id);
    }

    /// @notice Test 13: completeJob on non-Submitted state reverts.
    function test_completeJob_revertsOnWrongState() public {
        // Funded (no submit yet) -> wrong state.
        uint256 id = _create(1 ether);
        vm.prank(agent);
        vm.expectRevert(bytes("ACPJobStub: wrong state"));
        acp.completeJob(id);

        // Cancelled -> wrong state.
        uint256 id2 = _create(1 ether);
        vm.prank(requester);
        acp.cancelJob(id2);
        vm.prank(agent);
        vm.expectRevert(bytes("ACPJobStub: wrong state"));
        acp.completeJob(id2);
    }

    /// @notice Test 14: completeJob pays budget to agent.
    function test_completeJob_paysAgent() public {
        uint256 budget = 2.5 ether;
        uint256 id = _create(budget);
        vm.prank(agent);
        acp.submitResult(id, RESPONSE);

        uint256 agentBefore = agent.balance;
        vm.prank(agent);
        acp.completeJob(id);
        assertEq(agent.balance, agentBefore + budget);
    }

    /// @notice Test 15: completeJob transitions to Completed and decrements totalEscrow.
    function test_completeJob_transitionsAndUpdatesEscrow() public {
        uint256 id = _create(1 ether);
        vm.prank(agent);
        acp.submitResult(id, RESPONSE);

        uint256 escrowBefore = acp.totalEscrow();
        vm.warp(1_700_000_000);
        vm.prank(agent);
        acp.completeJob(id);

        ACPJobStub.Job memory job = acp.getJob(id);
        assertEq(uint8(job.state), uint8(ACPJobStub.State.Completed));
        assertEq(uint256(job.completedAt), 1_700_000_000);
        assertEq(acp.totalEscrow(), escrowBefore - 1 ether);
    }

    /// @notice Test 16: completeJob emits JobCompleted.
    function test_completeJob_emitsJobCompleted() public {
        uint256 id = _create(1 ether);
        vm.prank(agent);
        acp.submitResult(id, RESPONSE);

        vm.expectEmit(true, true, false, true, address(acp));
        emit JobCompleted(id, agent, 1 ether);
        vm.prank(agent);
        acp.completeJob(id);
    }

    // ---------- cancelJob ----------

    /// @notice Test 17: cancelJob by non-requester reverts.
    function test_cancelJob_revertsForNonRequester() public {
        uint256 id = _create(1 ether);
        vm.prank(agent);
        vm.expectRevert(bytes("ACPJobStub: not requester"));
        acp.cancelJob(id);
        vm.prank(stranger);
        vm.expectRevert(bytes("ACPJobStub: not requester"));
        acp.cancelJob(id);
    }

    /// @notice Test 18: cancelJob on non-Funded state reverts (e.g. after submit, completed).
    function test_cancelJob_revertsAfterSubmitOrComplete() public {
        // After submit -> wrong state.
        uint256 id = _create(1 ether);
        vm.prank(agent);
        acp.submitResult(id, RESPONSE);
        vm.prank(requester);
        vm.expectRevert(bytes("ACPJobStub: wrong state"));
        acp.cancelJob(id);

        // After complete -> wrong state.
        vm.prank(agent);
        acp.completeJob(id);
        vm.prank(requester);
        vm.expectRevert(bytes("ACPJobStub: wrong state"));
        acp.cancelJob(id);

        // Already Cancelled -> wrong state.
        uint256 id2 = _create(1 ether);
        vm.prank(requester);
        acp.cancelJob(id2);
        vm.prank(requester);
        vm.expectRevert(bytes("ACPJobStub: wrong state"));
        acp.cancelJob(id2);
    }

    /// @notice Test 19: cancelJob refunds requester.
    function test_cancelJob_refundsRequester() public {
        uint256 budget = 3 ether;
        uint256 reqBefore = requester.balance;
        uint256 id = _create(budget);
        // requester has paid out budget at this point.
        assertEq(requester.balance, reqBefore - budget);

        vm.prank(requester);
        acp.cancelJob(id);
        assertEq(requester.balance, reqBefore); // refunded back to original.
    }

    /// @notice Test 20: cancelJob transitions to Cancelled and decrements totalEscrow.
    function test_cancelJob_transitionsAndUpdatesEscrow() public {
        uint256 id = _create(1 ether);
        uint256 escrowBefore = acp.totalEscrow();
        vm.prank(requester);
        acp.cancelJob(id);

        ACPJobStub.Job memory job = acp.getJob(id);
        assertEq(uint8(job.state), uint8(ACPJobStub.State.Cancelled));
        assertEq(acp.totalEscrow(), escrowBefore - 1 ether);
    }

    /// @notice Test 21: cancelJob emits JobCancelled.
    function test_cancelJob_emitsJobCancelled() public {
        uint256 id = _create(1 ether);
        vm.expectEmit(true, true, false, true, address(acp));
        emit JobCancelled(id, requester, 1 ether);
        vm.prank(requester);
        acp.cancelJob(id);
    }

    // ---------- Edge cases ----------

    /// @notice Test 22: cannot complete twice — second call hits the wrong-state guard.
    function test_completeJob_cannotBeCalledTwice() public {
        uint256 id = _create(1 ether);
        vm.prank(agent);
        acp.submitResult(id, RESPONSE);
        vm.prank(agent);
        acp.completeJob(id);

        vm.prank(agent);
        vm.expectRevert(bytes("ACPJobStub: wrong state"));
        acp.completeJob(id);
    }

    /// @notice Test 23: totalEscrow is consistent across the happy path
    ///         (create -> submit -> complete drains escrow back to 0).
    function test_totalEscrow_consistentOnHappyPath() public {
        assertEq(acp.totalEscrow(), 0);
        uint256 id = _create(1.5 ether);
        assertEq(acp.totalEscrow(), 1.5 ether);

        vm.prank(agent);
        acp.submitResult(id, RESPONSE);
        // Submit doesn't move escrow.
        assertEq(acp.totalEscrow(), 1.5 ether);

        vm.prank(agent);
        acp.completeJob(id);
        assertEq(acp.totalEscrow(), 0);
    }

    /// @notice Bonus: isAgent / isRequester predicates behave correctly.
    function test_predicates_isAgentIsRequester() public {
        uint256 id = _create(1 ether);
        assertTrue(acp.isAgent(id, agent));
        assertFalse(acp.isAgent(id, requester));
        assertTrue(acp.isRequester(id, requester));
        assertFalse(acp.isRequester(id, agent));
    }
}
