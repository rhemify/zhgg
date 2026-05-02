// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title  AgenticCommerce — ERC-8183 Agentic Commerce Protocol implementation
/// @notice Job-escrow + evaluator-attestation primitive per ERC-8183.
///         Flow:
///         - client `createJob(provider, evaluator, expiredAt, desc)`
///         - client `fund(jobId, expectedBudget)` — pulls ERC-20 into escrow
///         - provider `submit(jobId, deliverable)` — bytes32 reference
///         - evaluator `complete(jobId, reason)` → escrow → provider, fee → treasury
///         - evaluator `reject(jobId, reason)` → escrow → client (refund)
///         - anyone `claimRefund(jobId)` after `expiredAt`
/// @dev    State machine: Open → Funded → Submitted → {Completed | Rejected | Expired}
///         Single `paymentToken` (ERC-20) per job for v1; multi-asset
///         escrow is post-spec scope.
///         Optional `IACPHook` per-job lets reputation / policy
///         contracts veto state transitions. Hook calls are gas-bounded
///         to prevent griefing the evaluator.
interface IACPHook {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}

contract AgenticCommerce is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum JobState { Open, Funded, Submitted, Completed, Rejected, Expired }

    struct Job {
        address client;       // who created + funded
        address provider;     // who delivers
        address evaluator;    // who attests Completed/Rejected
        IERC20  paymentToken; // escrowed asset
        uint256 budget;       // amount in escrow
        uint64  expiredAt;    // anyone may claimRefund after this
        JobState state;
        IACPHook hook;        // optional — address(0) skips hooks
        bytes32  deliverable; // set on submit
        bytes32  completionReason; // set on complete/reject
    }

    /// @notice Treasury that receives the optional protocol fee on
    ///         completion. Set once at deploy. Zero = no fee.
    address public immutable treasury;

    /// @notice Protocol fee in basis points (out of 10_000). Charged on
    ///         `complete` from the budget BEFORE the provider payout.
    ///         Settable to zero at deploy for fee-less operation.
    uint16  public immutable feeBps;

    /// @notice Hook gas cap. Prevents an evaluator-griefing scenario
    ///         where a malicious hook consumes 30M gas on
    ///         `beforeAction(complete)` and bricks the evaluator's tx.
    uint256 public constant HOOK_GAS_CAP = 250_000;

    uint256 public nextJobId = 1;
    mapping(uint256 => Job) private _jobs;

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider,
        address evaluator,
        uint64 expiredAt,
        string description,
        address hook
    );
    event JobFunded(
        uint256 indexed jobId,
        address indexed paymentToken,
        uint256 budget
    );
    event JobSubmitted(uint256 indexed jobId, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, bytes32 reason, uint256 providerPayout, uint256 fee);
    event JobRejected(uint256 indexed jobId, bytes32 reason, uint256 refunded);
    event JobExpired(uint256 indexed jobId, uint256 refunded);

    error InvalidJobId(uint256 jobId);
    error WrongState(uint256 jobId, JobState expected, JobState actual);
    error NotClient(address caller);
    error NotProvider(address caller);
    error NotEvaluator(address caller);
    error JobNotExpired(uint64 expiredAt, uint256 nowTs);
    error JobAlreadyExpired(uint64 expiredAt, uint256 nowTs);
    error ZeroBudget();
    error InvalidExpiry(uint64 expiredAt, uint256 nowTs);
    error FeeBpsTooLarge(uint16 fee);

    constructor(address treasury_, uint16 feeBps_) {
        if (feeBps_ > 10_000) revert FeeBpsTooLarge(feeBps_);
        treasury = treasury_;
        feeBps = feeBps_;
    }

    function jobOf(uint256 jobId)
        external
        view
        returns (
            address client,
            address provider,
            address evaluator,
            address paymentToken,
            uint256 budget,
            uint64 expiredAt,
            JobState state,
            address hook,
            bytes32 deliverable,
            bytes32 completionReason
        )
    {
        Job memory j = _jobs[jobId];
        if (j.client == address(0)) revert InvalidJobId(jobId);
        return (
            j.client,
            j.provider,
            j.evaluator,
            address(j.paymentToken),
            j.budget,
            j.expiredAt,
            j.state,
            address(j.hook),
            j.deliverable,
            j.completionReason
        );
    }

    /// @notice Open a new job. Provider/evaluator may be zero — if zero,
    ///         the client is the implicit provider/evaluator (allowed
    ///         for self-evaluating workflows; rare).
    function createJob(
        address provider,
        address evaluator,
        IERC20 paymentToken,
        uint64 expiredAt,
        string calldata description,
        IACPHook hook
    ) external returns (uint256 jobId) {
        if (expiredAt <= block.timestamp) revert InvalidExpiry(expiredAt, block.timestamp);
        jobId = nextJobId++;
        _jobs[jobId] = Job({
            client: msg.sender,
            provider: provider == address(0) ? msg.sender : provider,
            evaluator: evaluator == address(0) ? msg.sender : evaluator,
            paymentToken: paymentToken,
            budget: 0,
            expiredAt: expiredAt,
            state: JobState.Open,
            hook: hook,
            deliverable: bytes32(0),
            completionReason: bytes32(0)
        });
        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt, description, address(hook));
    }

    /// @notice Fund a job — pulls `expectedBudget` from the client and
    ///         records it in escrow. Transitions Open → Funded.
    function fund(uint256 jobId, uint256 expectedBudget) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.client == address(0)) revert InvalidJobId(jobId);
        if (j.state != JobState.Open) revert WrongState(jobId, JobState.Open, j.state);
        if (msg.sender != j.client) revert NotClient(msg.sender);
        if (expectedBudget == 0) revert ZeroBudget();

        _hookBefore(jobId, this.fund.selector, abi.encode(expectedBudget), j.hook);

        j.paymentToken.safeTransferFrom(msg.sender, address(this), expectedBudget);
        j.budget = expectedBudget;
        j.state = JobState.Funded;

        emit JobFunded(jobId, address(j.paymentToken), expectedBudget);
        _hookAfter(jobId, this.fund.selector, abi.encode(expectedBudget), j.hook);
    }

    /// @notice Provider records the deliverable. Transitions
    ///         Funded → Submitted.
    function submit(uint256 jobId, bytes32 deliverable) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.client == address(0)) revert InvalidJobId(jobId);
        if (j.state != JobState.Funded) revert WrongState(jobId, JobState.Funded, j.state);
        if (msg.sender != j.provider) revert NotProvider(msg.sender);
        if (block.timestamp > j.expiredAt) revert JobAlreadyExpired(j.expiredAt, block.timestamp);

        _hookBefore(jobId, this.submit.selector, abi.encode(deliverable), j.hook);

        j.deliverable = deliverable;
        j.state = JobState.Submitted;

        emit JobSubmitted(jobId, deliverable);
        _hookAfter(jobId, this.submit.selector, abi.encode(deliverable), j.hook);
    }

    /// @notice Evaluator attests successful completion. Releases escrow
    ///         to provider (minus protocol fee) and flips terminal.
    function complete(uint256 jobId, bytes32 reason) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.client == address(0)) revert InvalidJobId(jobId);
        if (j.state != JobState.Submitted) revert WrongState(jobId, JobState.Submitted, j.state);
        if (msg.sender != j.evaluator) revert NotEvaluator(msg.sender);

        _hookBefore(jobId, this.complete.selector, abi.encode(reason), j.hook);

        uint256 fee = (j.budget * feeBps) / 10_000;
        uint256 providerPayout = j.budget - fee;
        uint256 budgetCached = j.budget;

        j.budget = 0;
        j.completionReason = reason;
        j.state = JobState.Completed;

        if (providerPayout > 0) {
            j.paymentToken.safeTransfer(j.provider, providerPayout);
        }
        if (fee > 0 && treasury != address(0)) {
            j.paymentToken.safeTransfer(treasury, fee);
        }

        emit JobCompleted(jobId, reason, providerPayout, fee);
        _hookAfter(jobId, this.complete.selector, abi.encode(reason, budgetCached), j.hook);
    }

    /// @notice Evaluator rejects. Refunds escrow to client. May be called
    ///         from Open (client cancels their own unfunded job —
    ///         no-op token-wise) OR Funded/Submitted (refund client).
    function reject(uint256 jobId, bytes32 reason) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.client == address(0)) revert InvalidJobId(jobId);

        // Open: client cancels their own job before any escrow. No money
        // moves, but state flips Rejected so the slot can't be reused.
        if (j.state == JobState.Open) {
            if (msg.sender != j.client) revert NotClient(msg.sender);
            _hookBefore(jobId, this.reject.selector, abi.encode(reason), j.hook);
            j.completionReason = reason;
            j.state = JobState.Rejected;
            emit JobRejected(jobId, reason, 0);
            _hookAfter(jobId, this.reject.selector, abi.encode(reason, uint256(0)), j.hook);
            return;
        }

        if (j.state != JobState.Funded && j.state != JobState.Submitted) {
            revert WrongState(jobId, JobState.Submitted, j.state);
        }
        if (msg.sender != j.evaluator) revert NotEvaluator(msg.sender);

        _hookBefore(jobId, this.reject.selector, abi.encode(reason), j.hook);

        uint256 refund = j.budget;
        j.budget = 0;
        j.completionReason = reason;
        j.state = JobState.Rejected;

        if (refund > 0) j.paymentToken.safeTransfer(j.client, refund);

        emit JobRejected(jobId, reason, refund);
        _hookAfter(jobId, this.reject.selector, abi.encode(reason, refund), j.hook);
    }

    /// @notice After `expiredAt`, anyone may pull the escrow back to the
    ///         client. Permissionless on purpose — clients shouldn't have
    ///         to chase their own evaluator to recover funds.
    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.client == address(0)) revert InvalidJobId(jobId);
        if (block.timestamp <= j.expiredAt) revert JobNotExpired(j.expiredAt, block.timestamp);
        if (j.state != JobState.Funded && j.state != JobState.Submitted) {
            revert WrongState(jobId, JobState.Funded, j.state);
        }

        uint256 refund = j.budget;
        j.budget = 0;
        j.state = JobState.Expired;

        if (refund > 0) j.paymentToken.safeTransfer(j.client, refund);

        emit JobExpired(jobId, refund);
    }

    // ---------------------------------------------------------------------
    // Hooks
    // ---------------------------------------------------------------------

    function _hookBefore(uint256 jobId, bytes4 selector, bytes memory data, IACPHook hook) internal {
        if (address(hook) == address(0)) return;
        try hook.beforeAction{gas: HOOK_GAS_CAP}(jobId, selector, data) {
            // Hook accepted; continue.
        } catch {
            // Hook rejected — bubble up so the state transition reverts.
            revert("ACP: hook beforeAction reverted");
        }
    }

    function _hookAfter(uint256 jobId, bytes4 selector, bytes memory data, IACPHook hook) internal {
        if (address(hook) == address(0)) return;
        // After hooks are advisory — failure does NOT revert the state
        // transition. This matches the ERC-8183 design where the
        // primary contract is the source of truth for state.
        try hook.afterAction{gas: HOOK_GAS_CAP}(jobId, selector, data) {} catch {}
    }
}
