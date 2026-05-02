// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DelegationManager} from "../src/DelegationManager.sol";
import {AgentNFT} from "../src/AgentNFT.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";
import {AgentReceiverWallet} from "../src/AgentReceiverWallet.sol";
import {AgentReceiverWalletFactory} from "../src/AgentReceiverWalletFactory.sol";
import {SpendCap} from "../src/SpendCap.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
    function decimals() public pure override returns (uint8) { return 6; }
}

/// Bare ERC-20-recipient: lets a delegated swap-style call land somewhere
/// observable in tests without needing a full DEX deployment.
contract MockTarget {
    event Hit(address caller, uint256 value, bytes data);
    function ping(uint256 x) external payable returns (uint256) {
        emit Hit(msg.sender, msg.value, abi.encode(x));
        return x * 2;
    }
}

contract DelegationManagerTest is Test {
    DelegationManager   internal manager;
    AgentNFT            internal nft;
    FeeSplitter         internal splitter;
    AgentReceiverWalletFactory internal factory;
    SpendCap            internal cap;
    MockUSDC            internal usdc;
    MockTarget          internal target;

    AgentReceiverWallet internal wallet;
    uint256             internal tokenId;

    uint256 internal ownerPk = 0xA11CE;
    address internal ownerAddr;
    address internal delegate    = makeAddr("delegate");
    address internal stranger    = makeAddr("stranger");
    address internal khTreasury  = makeAddr("kh");
    address internal zhggTreas   = makeAddr("zhgg");
    address internal commonsTreas = makeAddr("commons");

    bytes32 internal constant TRADING_PERM = keccak256("zhgg.trading.v1");

    function setUp() public {
        ownerAddr = vm.addr(ownerPk);

        nft       = new AgentNFT();
        splitter  = new FeeSplitter(khTreasury, zhggTreas, commonsTreas);
        factory   = new AgentReceiverWalletFactory(address(nft), address(splitter));
        cap       = new SpendCap();
        usdc      = new MockUSDC();
        target    = new MockTarget();

        // Mint iNFT to the owner whose pk we control.
        tokenId = nft.mint(ownerAddr, hex"");
        wallet  = AgentReceiverWallet(payable(factory.deploy(tokenId)));

        // Deploy the manager wired to our SpendCap.
        manager = new DelegationManager(address(cap));

        // Owner authorizes the manager on the wallet.
        vm.prank(ownerAddr);
        wallet.setDelegationManager(address(manager));

        // Grant a SpendCap on the wallet for the trading permission.
        // The cap owner is the wallet itself for simplicity; in production
        // the iNFT owner would grant on behalf of the wallet via a separate
        // helper that calls `cap.grantPermission` from the wallet's address.
        vm.prank(address(wallet));
        cap.grantPermission(
            address(wallet),
            address(usdc),
            TRADING_PERM,
            100_000_000, // 100 USDC
            1 days,
            uint64(block.timestamp + 30 days)
        );

        // Fund the wallet with USDC so a real swap target could pull it.
        usdc.mint(address(wallet), 100_000_000);
    }

    // ---------- helpers ------------------------------------------------

    function _delegation(
        address target_,
        uint128 maxValue,
        uint64 expiresAt,
        bytes32 salt,
        address asset,
        bytes32 permId,
        uint128 maxAmount
    ) internal view returns (DelegationManager.Delegation memory d) {
        address[] memory targets = new address[](1);
        targets[0] = target_;
        d = DelegationManager.Delegation({
            delegator: address(wallet),
            delegate: delegate,
            allowedTargets: targets,
            maxValuePerCall: maxValue,
            expiresAt: expiresAt,
            salt: salt,
            spendCapAsset: asset,
            permissionId: permId,
            maxAmountPerRedeem: maxAmount
        });
    }

    function _signDelegation(DelegationManager.Delegation memory d, uint256 pk)
        internal
        view
        returns (bytes memory sig)
    {
        bytes32 digest = manager.hashDelegation(d);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function _redeem(
        DelegationManager.Delegation memory d,
        bytes memory sig,
        DelegationManager.Execution memory exec
    ) internal {
        bytes[] memory ctxs = new bytes[](1);
        bytes32[] memory modes = new bytes32[](1);
        bytes[] memory execs = new bytes[](1);
        ctxs[0] = abi.encode(d, sig);
        modes[0] = bytes32(0);
        execs[0] = abi.encode(exec);
        manager.redeemDelegations(ctxs, modes, execs);
    }

    // ---------- happy path ---------------------------------------------

    function test_redeem_executesThroughDelegatorWallet() public {
        DelegationManager.Delegation memory d = _delegation(
            address(target),
            0,
            uint64(block.timestamp + 1 hours),
            bytes32(uint256(1)),
            address(0), // no SpendCap debit
            bytes32(0),
            0
        );
        bytes memory sig = _signDelegation(d, ownerPk);

        DelegationManager.Execution memory exec = DelegationManager.Execution({
            target: address(target),
            value: 0,
            data: abi.encodeCall(MockTarget.ping, (42))
        });

        // Capture the Hit event to confirm target sees the WALLET as msg.sender,
        // not the manager — that's the whole point of routing through executeViaDelegation.
        vm.recordLogs();
        vm.prank(delegate);
        _redeem(d, sig, exec);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawHit;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(target)
                && logs[i].topics[0] == keccak256("Hit(address,uint256,bytes)")) {
                (address caller, , ) = abi.decode(logs[i].data, (address, uint256, bytes));
                assertEq(caller, address(wallet), "target should see wallet as msg.sender");
                sawHit = true;
                break;
            }
        }
        assertTrue(sawHit, "target.ping was not called");
    }

    function test_redeem_debitsSpendCapWhenAssetSet() public {
        DelegationManager.Delegation memory d = _delegation(
            address(target),
            0,
            uint64(block.timestamp + 1 hours),
            bytes32(uint256(2)),
            address(usdc),
            TRADING_PERM,
            30_000_000 // debit 30 USDC of the 100 USDC cap
        );
        bytes memory sig = _signDelegation(d, ownerPk);

        (, uint128 remainingBefore, , , , , ) = cap.permissionOf(address(wallet), address(usdc), TRADING_PERM);
        assertEq(remainingBefore, 100_000_000);

        DelegationManager.Execution memory exec = DelegationManager.Execution({
            target: address(target),
            value: 0,
            data: abi.encodeCall(MockTarget.ping, (1))
        });

        vm.prank(delegate);
        _redeem(d, sig, exec);

        (, uint128 remainingAfter, , , , , ) = cap.permissionOf(address(wallet), address(usdc), TRADING_PERM);
        assertEq(remainingAfter, 70_000_000, "spend cap not debited by maxAmountPerRedeem");
    }

    // ---------- caveat: target allowlist -------------------------------

    function test_redeem_revertsWhenTargetNotInAllowlist() public {
        DelegationManager.Delegation memory d = _delegation(
            address(target),
            0,
            uint64(block.timestamp + 1 hours),
            bytes32(uint256(3)),
            address(0),
            bytes32(0),
            0
        );
        bytes memory sig = _signDelegation(d, ownerPk);

        // Try to call a DIFFERENT target than the one in allowedTargets.
        DelegationManager.Execution memory exec = DelegationManager.Execution({
            target: address(0xDEAD),
            value: 0,
            data: hex""
        });

        vm.prank(delegate);
        vm.expectRevert(
            abi.encodeWithSelector(DelegationManager.TargetNotAllowed.selector, address(0xDEAD))
        );
        _redeem(d, sig, exec);
    }

    function test_redeem_revertsOnEmptyAllowedTargets() public {
        address[] memory empty = new address[](0);
        DelegationManager.Delegation memory d = DelegationManager.Delegation({
            delegator: address(wallet),
            delegate: delegate,
            allowedTargets: empty,
            maxValuePerCall: 0,
            expiresAt: uint64(block.timestamp + 1 hours),
            salt: bytes32(uint256(4)),
            spendCapAsset: address(0),
            permissionId: bytes32(0),
            maxAmountPerRedeem: 0
        });
        bytes memory sig = _signDelegation(d, ownerPk);

        DelegationManager.Execution memory exec = DelegationManager.Execution({
            target: address(target),
            value: 0,
            data: abi.encodeCall(MockTarget.ping, (1))
        });

        vm.prank(delegate);
        vm.expectRevert(DelegationManager.EmptyAllowedTargets.selector);
        _redeem(d, sig, exec);
    }

    // ---------- caveat: value cap --------------------------------------

    function test_redeem_revertsWhenValueExceedsCap() public {
        DelegationManager.Delegation memory d = _delegation(
            address(target),
            1 ether, // cap
            uint64(block.timestamp + 1 hours),
            bytes32(uint256(5)),
            address(0),
            bytes32(0),
            0
        );
        bytes memory sig = _signDelegation(d, ownerPk);

        DelegationManager.Execution memory exec = DelegationManager.Execution({
            target: address(target),
            value: 2 ether, // exceeds
            data: abi.encodeCall(MockTarget.ping, (1))
        });

        vm.deal(delegate, 5 ether);
        vm.prank(delegate);
        vm.expectRevert(
            abi.encodeWithSelector(DelegationManager.ValueExceedsCap.selector, uint256(2 ether), uint128(1 ether))
        );
        bytes[] memory ctxs = new bytes[](1);
        bytes32[] memory modes = new bytes32[](1);
        bytes[] memory execs = new bytes[](1);
        ctxs[0] = abi.encode(d, sig);
        modes[0] = bytes32(0);
        execs[0] = abi.encode(exec);
        manager.redeemDelegations{value: 2 ether}(ctxs, modes, execs);
    }

    // ---------- caveat: expiry -----------------------------------------

    function test_redeem_revertsAfterExpiry() public {
        uint64 expiresAt = uint64(block.timestamp + 100);
        DelegationManager.Delegation memory d = _delegation(
            address(target),
            0,
            expiresAt,
            bytes32(uint256(6)),
            address(0),
            bytes32(0),
            0
        );
        bytes memory sig = _signDelegation(d, ownerPk);

        vm.warp(expiresAt + 1);

        DelegationManager.Execution memory exec = DelegationManager.Execution({
            target: address(target),
            value: 0,
            data: abi.encodeCall(MockTarget.ping, (1))
        });

        vm.prank(delegate);
        vm.expectRevert(
            abi.encodeWithSelector(DelegationManager.DelegationExpired.selector, expiresAt, block.timestamp)
        );
        _redeem(d, sig, exec);
    }

    // ---------- delegate identity --------------------------------------

    function test_redeem_revertsWhenCallerNotDelegate() public {
        DelegationManager.Delegation memory d = _delegation(
            address(target),
            0,
            uint64(block.timestamp + 1 hours),
            bytes32(uint256(7)),
            address(0),
            bytes32(0),
            0
        );
        bytes memory sig = _signDelegation(d, ownerPk);

        DelegationManager.Execution memory exec = DelegationManager.Execution({
            target: address(target),
            value: 0,
            data: abi.encodeCall(MockTarget.ping, (1))
        });

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(DelegationManager.WrongDelegate.selector, delegate, stranger)
        );
        _redeem(d, sig, exec);
    }

    // ---------- replay defense -----------------------------------------

    function test_redeem_revertsOnReplay() public {
        DelegationManager.Delegation memory d = _delegation(
            address(target),
            0,
            uint64(block.timestamp + 1 hours),
            bytes32(uint256(8)),
            address(0),
            bytes32(0),
            0
        );
        bytes memory sig = _signDelegation(d, ownerPk);

        DelegationManager.Execution memory exec = DelegationManager.Execution({
            target: address(target),
            value: 0,
            data: abi.encodeCall(MockTarget.ping, (1))
        });

        vm.prank(delegate);
        _redeem(d, sig, exec);

        // Second redemption MUST revert.
        bytes32 redemptionKey = keccak256(abi.encode(address(wallet), bytes32(uint256(8))));
        vm.prank(delegate);
        vm.expectRevert(
            abi.encodeWithSelector(DelegationManager.AlreadyRedeemed.selector, redemptionKey)
        );
        _redeem(d, sig, exec);
    }

    function test_redeem_distinctSaltsAreIndependent() public {
        DelegationManager.Delegation memory d1 = _delegation(
            address(target), 0, uint64(block.timestamp + 1 hours), bytes32(uint256(11)), address(0), bytes32(0), 0
        );
        DelegationManager.Delegation memory d2 = _delegation(
            address(target), 0, uint64(block.timestamp + 1 hours), bytes32(uint256(12)), address(0), bytes32(0), 0
        );
        bytes memory sig1 = _signDelegation(d1, ownerPk);
        bytes memory sig2 = _signDelegation(d2, ownerPk);

        DelegationManager.Execution memory exec = DelegationManager.Execution({
            target: address(target),
            value: 0,
            data: abi.encodeCall(MockTarget.ping, (1))
        });

        vm.prank(delegate);
        _redeem(d1, sig1, exec);

        // Different salt → different redemption key → succeeds.
        vm.prank(delegate);
        _redeem(d2, sig2, exec);
    }

    // ---------- signature ----------------------------------------------

    function test_redeem_revertsOnBadSignature() public {
        DelegationManager.Delegation memory d = _delegation(
            address(target),
            0,
            uint64(block.timestamp + 1 hours),
            bytes32(uint256(9)),
            address(0),
            bytes32(0),
            0
        );
        // Sign with a key that is NOT the iNFT owner.
        bytes memory badSig = _signDelegation(d, 0xBAD);

        DelegationManager.Execution memory exec = DelegationManager.Execution({
            target: address(target),
            value: 0,
            data: abi.encodeCall(MockTarget.ping, (1))
        });

        vm.prank(delegate);
        vm.expectRevert(DelegationManager.InvalidSignature.selector);
        _redeem(d, badSig, exec);
    }

    // ---------- mode support -------------------------------------------

    function test_redeem_revertsOnUnsupportedMode() public {
        DelegationManager.Delegation memory d = _delegation(
            address(target),
            0,
            uint64(block.timestamp + 1 hours),
            bytes32(uint256(10)),
            address(0),
            bytes32(0),
            0
        );
        bytes memory sig = _signDelegation(d, ownerPk);

        DelegationManager.Execution memory exec = DelegationManager.Execution({
            target: address(target),
            value: 0,
            data: abi.encodeCall(MockTarget.ping, (1))
        });

        bytes[] memory ctxs = new bytes[](1);
        bytes32[] memory modes = new bytes32[](1);
        bytes[] memory execs = new bytes[](1);
        ctxs[0] = abi.encode(d, sig);
        modes[0] = bytes32(uint256(0xff)); // unsupported
        execs[0] = abi.encode(exec);

        vm.prank(delegate);
        vm.expectRevert(
            abi.encodeWithSelector(DelegationManager.UnsupportedMode.selector, bytes32(uint256(0xff)))
        );
        manager.redeemDelegations(ctxs, modes, execs);
    }

    // ---------- atomic batch -------------------------------------------

    function test_redeem_atomicBatch_secondFailureRevertsFirst() public {
        DelegationManager.Delegation memory d1 = _delegation(
            address(target), 0, uint64(block.timestamp + 1 hours),
            bytes32(uint256(13)), address(0), bytes32(0), 0
        );
        // d2 has a target NOT in its allowlist → will revert.
        DelegationManager.Delegation memory d2 = _delegation(
            address(target), 0, uint64(block.timestamp + 1 hours),
            bytes32(uint256(14)), address(0), bytes32(0), 0
        );
        bytes memory sig1 = _signDelegation(d1, ownerPk);
        bytes memory sig2 = _signDelegation(d2, ownerPk);

        DelegationManager.Execution memory exec1 = DelegationManager.Execution({
            target: address(target), value: 0,
            data: abi.encodeCall(MockTarget.ping, (1))
        });
        DelegationManager.Execution memory exec2 = DelegationManager.Execution({
            target: address(0xBAD0), value: 0, data: hex""
        });

        bytes[] memory ctxs = new bytes[](2);
        bytes32[] memory modes = new bytes32[](2);
        bytes[] memory execs = new bytes[](2);
        ctxs[0] = abi.encode(d1, sig1);
        ctxs[1] = abi.encode(d2, sig2);
        modes[0] = bytes32(0); modes[1] = bytes32(0);
        execs[0] = abi.encode(exec1);
        execs[1] = abi.encode(exec2);

        vm.prank(delegate);
        vm.expectRevert();
        manager.redeemDelegations(ctxs, modes, execs);

        // Confirm first redemption was rolled back: salt #13 must NOT
        // be marked redeemed.
        bytes32 redemptionKey = keccak256(abi.encode(address(wallet), bytes32(uint256(13))));
        assertFalse(manager.redeemed(redemptionKey), "atomic batch did not roll back first leg");
    }

    // ---------- length mismatch ----------------------------------------

    function test_redeem_revertsOnLengthMismatch() public {
        bytes[] memory ctxs = new bytes[](2);
        bytes32[] memory modes = new bytes32[](1);
        bytes[] memory execs = new bytes[](2);
        vm.prank(delegate);
        vm.expectRevert(DelegationManager.LengthMismatch.selector);
        manager.redeemDelegations(ctxs, modes, execs);
    }
}
