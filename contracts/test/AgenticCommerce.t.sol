// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgenticCommerce, IACPHook} from "../src/AgenticCommerce.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
    function decimals() public pure override returns (uint8) { return 6; }
}

/// Hook that records calls. Lets us verify the gas-cap + revert path.
contract RecordingHook is IACPHook {
    bool public shouldRevertBefore;
    bool public shouldRevertAfter;
    bool public beforeWasCalled;
    bool public afterWasCalled;

    function setShouldRevertBefore(bool v) external { shouldRevertBefore = v; }
    function setShouldRevertAfter(bool v) external { shouldRevertAfter = v; }

    function beforeAction(uint256, bytes4, bytes calldata) external override {
        beforeWasCalled = true;
        if (shouldRevertBefore) revert("hook before reverted");
    }
    function afterAction(uint256, bytes4, bytes calldata) external override {
        afterWasCalled = true;
        if (shouldRevertAfter) revert("hook after reverted");
    }
}

contract AgenticCommerceTest is Test {
    AgenticCommerce internal acp;
    MockUSDC internal usdc;

    address internal client    = makeAddr("client");
    address internal provider  = makeAddr("provider");
    address internal evaluator = makeAddr("evaluator");
    address internal stranger  = makeAddr("stranger");
    address internal treasury  = makeAddr("treasury");

    uint16 internal constant FEE_BPS = 250; // 2.5%

    function setUp() public {
        acp = new AgenticCommerce(treasury, FEE_BPS);
        usdc = new MockUSDC();
        usdc.mint(client, 1_000_000e6);
        vm.prank(client);
        usdc.approve(address(acp), type(uint256).max);
    }

    // ---------- create / fund / submit / complete ----------------------

    function test_createJob_storesAllFields() public {
        uint64 deadline = uint64(block.timestamp + 1 days);
        vm.prank(client);
        uint256 id = acp.createJob(provider, evaluator, IERC20(address(usdc)), deadline, "audit me", IACPHook(address(0)));
        assertEq(id, 1);

        (
            address c, address p, address e, address pt, uint256 b, uint64 ex, AgenticCommerce.JobState s,
            address h, bytes32 d, bytes32 r
        ) = acp.jobOf(id);
        assertEq(c, client);
        assertEq(p, provider);
        assertEq(e, evaluator);
        assertEq(pt, address(usdc));
        assertEq(b, 0);
        assertEq(ex, deadline);
        assertEq(uint256(s), uint256(AgenticCommerce.JobState.Open));
        assertEq(h, address(0));
        assertEq(d, bytes32(0));
        assertEq(r, bytes32(0));
    }

    function test_createJob_revertsOnPastDeadline() public {
        vm.prank(client);
        vm.expectRevert();
        acp.createJob(provider, evaluator, IERC20(address(usdc)), uint64(block.timestamp - 1), "x", IACPHook(address(0)));
    }

    function test_fund_pullsBudgetAndTransitions() public {
        uint256 id = _createJob();

        vm.prank(client);
        acp.fund(id, 100e6);

        (, , , , uint256 b, , AgenticCommerce.JobState s, , , ) = acp.jobOf(id);
        assertEq(b, 100e6);
        assertEq(uint256(s), uint256(AgenticCommerce.JobState.Funded));
        assertEq(usdc.balanceOf(address(acp)), 100e6);
    }

    function test_fund_revertsForNonClient() public {
        uint256 id = _createJob();
        vm.prank(stranger);
        vm.expectRevert();
        acp.fund(id, 100e6);
    }

    function test_fund_revertsOnZeroBudget() public {
        uint256 id = _createJob();
        vm.prank(client);
        vm.expectRevert(AgenticCommerce.ZeroBudget.selector);
        acp.fund(id, 0);
    }

    function test_submit_recordsDeliverableAndTransitions() public {
        uint256 id = _createAndFund();

        vm.prank(provider);
        acp.submit(id, keccak256("audit-report-v1"));

        (, , , , , , AgenticCommerce.JobState s, , bytes32 d, ) = acp.jobOf(id);
        assertEq(uint256(s), uint256(AgenticCommerce.JobState.Submitted));
        assertEq(d, keccak256("audit-report-v1"));
    }

    function test_submit_revertsForNonProvider() public {
        uint256 id = _createAndFund();
        vm.prank(stranger);
        vm.expectRevert();
        acp.submit(id, bytes32(uint256(1)));
    }

    function test_complete_paysProviderMinusFee() public {
        uint256 id = _createFundSubmit(100e6);

        vm.prank(evaluator);
        acp.complete(id, keccak256("ok"));

        // 2.5% of 100e6 = 2_500_000 fee, 97_500_000 to provider
        assertEq(usdc.balanceOf(provider), 97_500_000);
        assertEq(usdc.balanceOf(treasury), 2_500_000);
        assertEq(usdc.balanceOf(address(acp)), 0);

        (, , , , , , AgenticCommerce.JobState s, , , bytes32 r) = acp.jobOf(id);
        assertEq(uint256(s), uint256(AgenticCommerce.JobState.Completed));
        assertEq(r, keccak256("ok"));
    }

    function test_complete_revertsForNonEvaluator() public {
        uint256 id = _createFundSubmit(100e6);
        vm.prank(stranger);
        vm.expectRevert();
        acp.complete(id, bytes32(uint256(1)));
    }

    // ---------- reject paths -------------------------------------------

    function test_reject_fromOpen_byClient_clearsState() public {
        uint256 id = _createJob();
        vm.prank(client);
        acp.reject(id, keccak256("changed mind"));

        (, , , , uint256 b, , AgenticCommerce.JobState s, , , bytes32 r) = acp.jobOf(id);
        assertEq(b, 0);
        assertEq(uint256(s), uint256(AgenticCommerce.JobState.Rejected));
        assertEq(r, keccak256("changed mind"));
    }

    function test_reject_fromOpen_revertsForNonClient() public {
        uint256 id = _createJob();
        vm.prank(stranger);
        vm.expectRevert();
        acp.reject(id, bytes32(uint256(1)));
    }

    function test_reject_fromFunded_byEvaluator_refundsClient() public {
        uint256 id = _createAndFund();
        uint256 clientBalanceBefore = usdc.balanceOf(client);

        vm.prank(evaluator);
        acp.reject(id, keccak256("bad work"));

        assertEq(usdc.balanceOf(client), clientBalanceBefore + 100e6);
        (, , , , uint256 b, , AgenticCommerce.JobState s, , , ) = acp.jobOf(id);
        assertEq(b, 0);
        assertEq(uint256(s), uint256(AgenticCommerce.JobState.Rejected));
    }

    function test_reject_fromSubmitted_byEvaluator_refundsClient() public {
        uint256 id = _createFundSubmit(100e6);
        uint256 clientBalanceBefore = usdc.balanceOf(client);

        vm.prank(evaluator);
        acp.reject(id, bytes32(uint256(2)));

        assertEq(usdc.balanceOf(client), clientBalanceBefore + 100e6);
    }

    // ---------- expiry / claimRefund -----------------------------------

    function test_claimRefund_succeedsAfterExpiry() public {
        uint256 id = _createAndFund();
        vm.warp(block.timestamp + 2 days); // past expiry

        uint256 clientBefore = usdc.balanceOf(client);
        // Even a stranger may claim — the refund still goes to the client.
        vm.prank(stranger);
        acp.claimRefund(id);
        assertEq(usdc.balanceOf(client), clientBefore + 100e6);
        (, , , , , , AgenticCommerce.JobState s, , , ) = acp.jobOf(id);
        assertEq(uint256(s), uint256(AgenticCommerce.JobState.Expired));
    }

    function test_claimRefund_revertsBeforeExpiry() public {
        uint256 id = _createAndFund();
        vm.expectRevert();
        acp.claimRefund(id);
    }

    function test_claimRefund_revertsForCompletedJob() public {
        uint256 id = _createFundSubmit(100e6);
        vm.prank(evaluator);
        acp.complete(id, bytes32(uint256(1)));
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert();
        acp.claimRefund(id);
    }

    // ---------- hooks --------------------------------------------------

    function test_hook_beforeAction_canRevertTransition() public {
        RecordingHook hook = new RecordingHook();
        hook.setShouldRevertBefore(true);

        vm.prank(client);
        uint256 id = acp.createJob(
            provider, evaluator, IERC20(address(usdc)),
            uint64(block.timestamp + 1 days), "x", IACPHook(address(hook))
        );

        vm.prank(client);
        vm.expectRevert();
        acp.fund(id, 100e6);
    }

    function test_hook_afterAction_revertDoesNotRollState() public {
        RecordingHook hook = new RecordingHook();
        hook.setShouldRevertAfter(true);

        vm.prank(client);
        uint256 id = acp.createJob(
            provider, evaluator, IERC20(address(usdc)),
            uint64(block.timestamp + 1 days), "x", IACPHook(address(hook))
        );

        // Should NOT revert — afterAction failures are advisory and
        // swallowed by the contract's try/catch. State + escrow must
        // survive the after-hook revert.
        vm.prank(client);
        acp.fund(id, 100e6);

        (, , , , uint256 b, , AgenticCommerce.JobState s, , , ) = acp.jobOf(id);
        assertEq(uint256(s), uint256(AgenticCommerce.JobState.Funded));
        assertEq(b, 100e6);
        assertEq(usdc.balanceOf(address(acp)), 100e6);
        // beforeWasCalled persists because beforeAction did not revert.
        // afterWasCalled does NOT persist because the revert rolled back
        // its own storage write — that's expected EVM semantics, not a
        // contract bug.
        assertTrue(hook.beforeWasCalled());
    }

    // ---------- constructor --------------------------------------------

    function test_constructor_revertsOnFeeBpsTooLarge() public {
        vm.expectRevert();
        new AgenticCommerce(treasury, 10_001);
    }

    function test_constructor_zeroFeeBpsAllowed() public {
        AgenticCommerce zeroFee = new AgenticCommerce(treasury, 0);
        // No revert + no fee on completion.
        usdc.mint(client, 100e6);
        vm.prank(client);
        usdc.approve(address(zeroFee), type(uint256).max);

        vm.prank(client);
        uint256 id = zeroFee.createJob(provider, evaluator, IERC20(address(usdc)), uint64(block.timestamp + 1 days), "x", IACPHook(address(0)));
        vm.prank(client);
        zeroFee.fund(id, 100e6);
        vm.prank(provider);
        zeroFee.submit(id, bytes32(uint256(1)));
        vm.prank(evaluator);
        zeroFee.complete(id, bytes32(uint256(1)));
        // Provider gets the entire budget.
        assertEq(usdc.balanceOf(provider), 100e6);
    }

    // ---------- helpers ------------------------------------------------

    function _createJob() internal returns (uint256) {
        vm.prank(client);
        return acp.createJob(
            provider, evaluator, IERC20(address(usdc)),
            uint64(block.timestamp + 1 days), "audit", IACPHook(address(0))
        );
    }

    function _createAndFund() internal returns (uint256 id) {
        id = _createJob();
        vm.prank(client);
        acp.fund(id, 100e6);
    }

    function _createFundSubmit(uint256 budget) internal returns (uint256 id) {
        vm.prank(client);
        id = acp.createJob(
            provider, evaluator, IERC20(address(usdc)),
            uint64(block.timestamp + 1 days), "audit", IACPHook(address(0))
        );
        vm.prank(client);
        acp.fund(id, budget);
        vm.prank(provider);
        acp.submit(id, keccak256("deliverable"));
    }
}
