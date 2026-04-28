// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ACPJobStub
/// @notice Minimal Agent Commerce Protocol job-lifecycle contract for zhgg v1.
/// @dev Single-transaction lifecycle: Open -> Funded -> Submitted -> Completed (or Cancelled
///      from Funded). No evaluator wait, no dispute layer in v1. createJob merges the Open
///      and Funded states because escrow is deposited atomically with job creation.
contract ACPJobStub is ReentrancyGuard {
    /// @notice Lifecycle states for a job.
    /// @dev Open is reserved for future flows where funding lags creation; v1 jumps straight
    ///      to Funded inside createJob.
    enum State {
        Open,
        Funded,
        Submitted,
        Completed,
        Cancelled
    }

    /// @notice The full job record stored on-chain.
    struct Job {
        address agent;
        address requester;
        uint256 budget;
        State state;
        bytes32 intentHash;
        bytes32 responseHash;
        uint64 createdAt;
        uint64 completedAt;
    }

    /// @notice id => Job record.
    mapping(uint256 => Job) public jobs;

    /// @notice Monotonic counter; ids start at 1 (the first createJob assigns id 1).
    uint256 public nextJobId;

    /// @notice Sum of currently-held budgets across all Funded/Submitted jobs.
    uint256 public totalEscrow;

    /// @notice Emitted when a new job is created and funded.
    event JobCreated(
        uint256 indexed id,
        address indexed requester,
        address indexed agent,
        uint256 budget,
        bytes32 intentHash
    );

    /// @notice Emitted when the agent submits a response hash for a funded job.
    event JobSubmitted(uint256 indexed id, bytes32 responseHash);

    /// @notice Emitted when a submitted job is marked complete and the agent is paid.
    event JobCompleted(uint256 indexed id, address indexed agent, uint256 payout);

    /// @notice Emitted when a funded job is cancelled and the requester is refunded.
    event JobCancelled(uint256 indexed id, address indexed requester, uint256 refund);

    /// @notice Create a new job, funding it with msg.value as escrow.
    /// @dev Increments nextJobId, stores the job in state Funded, and increments totalEscrow.
    /// @param agent The address that will perform the work and receive payout on completion.
    /// @param intentHash keccak256 commitment to the off-chain request payload.
    /// @return id The newly assigned job id (>= 1).
    function createJob(address agent, bytes32 intentHash) external payable returns (uint256 id) {
        require(msg.value > 0, "ACPJobStub: budget is zero");
        require(agent != address(0), "ACPJobStub: agent is zero");

        unchecked {
            id = ++nextJobId;
        }

        jobs[id] = Job({
            agent: agent,
            requester: msg.sender,
            budget: msg.value,
            state: State.Funded,
            intentHash: intentHash,
            responseHash: bytes32(0),
            createdAt: uint64(block.timestamp),
            completedAt: 0
        });

        totalEscrow += msg.value;

        emit JobCreated(id, msg.sender, agent, msg.value, intentHash);
    }

    /// @notice Agent submits the response hash for a funded job, transitioning it to Submitted.
    /// @dev Only the recorded agent may call. Job must be in state Funded.
    /// @param id The job id.
    /// @param responseHash keccak256 commitment to the off-chain response payload.
    function submitResult(uint256 id, bytes32 responseHash) external {
        Job storage job = jobs[id];
        require(msg.sender == job.agent, "ACPJobStub: not agent");
        require(job.state == State.Funded, "ACPJobStub: wrong state");

        job.responseHash = responseHash;
        job.state = State.Submitted;

        emit JobSubmitted(id, responseHash);
    }

    /// @notice Agent finalises a submitted job, releasing escrow as payout to the agent.
    /// @dev Only the recorded agent may call. Job must be in state Submitted. Reentrancy-guarded.
    /// @param id The job id.
    function completeJob(uint256 id) external nonReentrant {
        Job storage job = jobs[id];
        require(msg.sender == job.agent, "ACPJobStub: not agent");
        require(job.state == State.Submitted, "ACPJobStub: wrong state");

        uint256 payout = job.budget;
        address payable recipient = payable(job.agent);

        job.state = State.Completed;
        job.completedAt = uint64(block.timestamp);
        totalEscrow -= payout;

        (bool ok, ) = recipient.call{value: payout}("");
        require(ok, "ACPJobStub: payout failed");

        emit JobCompleted(id, recipient, payout);
    }

    /// @notice Requester cancels a funded job before submission, reclaiming the escrow.
    /// @dev Only the requester may call. Job must be in state Funded (cannot cancel post-submit).
    ///      Reentrancy-guarded.
    /// @param id The job id.
    function cancelJob(uint256 id) external nonReentrant {
        Job storage job = jobs[id];
        require(msg.sender == job.requester, "ACPJobStub: not requester");
        require(job.state == State.Funded, "ACPJobStub: wrong state");

        uint256 refund = job.budget;
        address payable recipient = payable(job.requester);

        job.state = State.Cancelled;
        totalEscrow -= refund;

        (bool ok, ) = recipient.call{value: refund}("");
        require(ok, "ACPJobStub: refund failed");

        emit JobCancelled(id, recipient, refund);
    }

    /// @notice Returns the full Job struct for a given id.
    /// @param id The job id.
    /// @return The Job record (zero-initialised if id was never used).
    function getJob(uint256 id) external view returns (Job memory) {
        return jobs[id];
    }

    /// @notice Convenience predicate: is `who` the agent for job `id`?
    /// @param id The job id.
    /// @param who Address to test.
    /// @return True if `who` matches the recorded agent.
    function isAgent(uint256 id, address who) external view returns (bool) {
        return jobs[id].agent == who;
    }

    /// @notice Convenience predicate: is `who` the requester for job `id`?
    /// @param id The job id.
    /// @param who Address to test.
    /// @return True if `who` matches the recorded requester.
    function isRequester(uint256 id, address who) external view returns (bool) {
        return jobs[id].requester == who;
    }
}
