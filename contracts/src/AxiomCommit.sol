// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  AxiomCommit — pre-commit / reveal log for agent execution plans
/// @notice Implements Steps 3 & 10 of the zhgg always-active audit loop.
///         An agent commits to a `planHash` BEFORE any external call (Step
///         3), then reveals the underlying plan + result AFTER receipt
///         post (Step 10). The contract is a hash registry only — it
///         never sees the plan bytes until reveal, and it never executes
///         them. This gives the audit log a tamper-evident record that
///         the agent had decided what to do BEFORE being told what the
///         oracle returned, blocking front-run-style plan substitution.
/// @dev    Append-only by design: the same `tokenId` can have many open
///         commits in flight. Each commit's id is
///         `keccak256(tokenId || planHash || msg.sender || block.number)`,
///         which means re-committing the same tuple in the same block is
///         idempotent (RPC retry safe). Storage cost is one packed SSTORE
///         per commit (`committer` + `blockNumber` + `revealed` flag fit
///         in a single 256-bit slot; `planHash` is in a parallel mapping).
contract AxiomCommit {
    /// @notice Upper bound on `plan` and `result` bytes accepted by
    ///         `revealPlan`. Each is non-indexed in `PlanRevealed`, so
    ///         unbounded reveals can blow past block gas. 8 KB covers
    ///         every realistic agent plan (typical canonical-JSON plan
    ///         is ~1 KB) while keeping a single reveal under ~250k gas.
    uint256 public constant MAX_PLAN_SIZE = 8192;

    struct Commit {
        address committer;   // 160 bits
        uint64  blockNumber; //  64 bits
        bool    revealed;    //   8 bits — packs with the above into 1 slot
    }

    mapping(bytes32 => Commit)  private _commits;
    mapping(bytes32 => bytes32) private _planHashOf;

    event PlanCommitted(
        uint256 indexed tokenId,
        bytes32 indexed commitId,
        bytes32 planHash,
        address indexed committer,
        uint256 blockNumber
    );

    /// @dev `plan` and `result` are non-indexed bytes — the hash anchors
    ///      `commitId`; the plaintext lives on logs for off-chain audit
    ///      indexers (cheaper than calldata storage).
    event PlanRevealed(
        uint256 indexed tokenId,
        bytes32 indexed commitId,
        bytes plan,
        bytes result
    );

    error CommitNotFound(bytes32 commitId);
    error AlreadyRevealed(bytes32 commitId);
    error NotCommitter(bytes32 commitId, address caller);
    error PlanHashMismatch(bytes32 expected, bytes32 actual);
    error EmptyPlan();
    error PlanTooLarge(uint256 size, uint256 max);
    error ResultTooLarge(uint256 size, uint256 max);

    /// @notice Commit to a plan hash for `tokenId`.
    /// @param  tokenId   iNFT whose agent is about to act.
    /// @param  planHash  keccak256(canonical plan bytes). Caller computes.
    /// @return commitId  Unique handle the caller passes back at reveal.
    function commitPlan(uint256 tokenId, bytes32 planHash) external returns (bytes32 commitId) {
        commitId = keccak256(abi.encodePacked(tokenId, planHash, msg.sender, block.number));
        Commit storage existing = _commits[commitId];
        // Idempotent in same block: re-committing the same (tokenId,
        // planHash, sender, block) tuple is a no-op rather than a revert
        // so RPC retries don't burn the run.
        if (existing.committer == address(0)) {
            _commits[commitId] = Commit({
                committer: msg.sender,
                blockNumber: uint64(block.number),
                revealed: false
            });
            _planHashOf[commitId] = planHash;
            emit PlanCommitted(tokenId, commitId, planHash, msg.sender, block.number);
        }
    }

    /// @notice Reveal a previously committed plan + the result it produced.
    /// @dev    Only the original committer can reveal. Verifies
    ///         `keccak256(plan) == storedHash`. Marks revealed so the
    ///         same commit can't be replayed against a different result.
    function revealPlan(
        uint256 tokenId,
        bytes32 commitId,
        bytes calldata plan,
        bytes calldata result
    ) external {
        Commit storage c = _commits[commitId];
        if (c.committer == address(0)) revert CommitNotFound(commitId);
        if (c.revealed) revert AlreadyRevealed(commitId);
        if (msg.sender != c.committer) revert NotCommitter(commitId, msg.sender);
        if (plan.length == 0) revert EmptyPlan();
        if (plan.length > MAX_PLAN_SIZE) revert PlanTooLarge(plan.length, MAX_PLAN_SIZE);
        if (result.length > MAX_PLAN_SIZE) revert ResultTooLarge(result.length, MAX_PLAN_SIZE);

        bytes32 actual = keccak256(plan);
        bytes32 expected = _planHashOf[commitId];
        if (actual != expected) revert PlanHashMismatch(expected, actual);

        c.revealed = true;
        emit PlanRevealed(tokenId, commitId, plan, result);
    }

    function commitOf(bytes32 commitId)
        external
        view
        returns (address committer, uint64 blockNumber, bool revealed, bytes32 planHash)
    {
        Commit memory c = _commits[commitId];
        return (c.committer, c.blockNumber, c.revealed, _planHashOf[commitId]);
    }
}
