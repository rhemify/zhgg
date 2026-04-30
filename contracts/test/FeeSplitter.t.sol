// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";
import {ERC8021Suffix} from "../src/lib/ERC8021Suffix.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function decimals() public pure override returns (uint8) { return 6; }
}

contract FeeSplitterTest is Test {
    FeeSplitter internal splitter;
    MockUSDC internal usdc;

    address internal keeper  = address(0xBEEF);
    address internal zhgg    = address(0xCAFE);
    address internal commons = address(0xDADA);

    address internal payer       = address(0x1111);
    address internal agentOwner  = address(0x2222);

    event Split(
        address indexed agentOwner,
        address indexed asset,
        uint256 totalAmount,
        uint256 ownerCut,
        uint256 keeperCut,
        uint256 zhggCut,
        uint256 commonsCut,
        bytes32 attributionTag
    );

    function setUp() public {
        splitter = new FeeSplitter(keeper, zhgg, commons);
        usdc = new MockUSDC();
        usdc.mint(payer, 1_000_000e6);
        vm.prank(payer);
        usdc.approve(address(splitter), type(uint256).max);
        vm.deal(payer, 100 ether);
    }

    function test_constants_sumTo10000() public view {
        assertEq(
            splitter.OWNER_BPS() + splitter.KEEPER_BPS() + splitter.ZHGG_BPS() + splitter.COMMONS_BPS(),
            splitter.BPS_DENOM()
        );
    }

    function test_constructor_rejectsZeroAddress() public {
        vm.expectRevert(FeeSplitter.ZeroAddress.selector);
        new FeeSplitter(address(0), zhgg, commons);
    }

    // ----- ERC20 -----

    function test_splitERC20_distributes85_5_5_5() public {
        uint256 total = 100e6; // 100 USDC
        vm.prank(payer);
        splitter.splitERC20(usdc, total, agentOwner);

        assertEq(usdc.balanceOf(agentOwner),         85e6); // 85
        assertEq(usdc.balanceOf(keeper),             5e6);  // 5
        assertEq(usdc.balanceOf(zhgg),               5e6);  // 5
        assertEq(usdc.balanceOf(commons),            5e6);  // 5
        assertEq(usdc.balanceOf(address(splitter)),  0);
    }

    function test_splitERC20_revertsBelowMinimum() public {
        // Below MIN_SPLIT_AMOUNT (10000) the 5% cuts floor to zero, which
        // would let a spammer attribute volume to a victim agent owner.
        // Reverting keeps every Split event meaningful.
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(FeeSplitter.AmountBelowMinimum.selector, uint256(7), uint256(10000))
        );
        splitter.splitERC20(usdc, 7, agentOwner);
    }

    function test_splitERC20_minimumExactlyAcceptable() public {
        // At exactly MIN_SPLIT_AMOUNT, every leg gets at least 1 atomic unit.
        vm.prank(payer);
        splitter.splitERC20(usdc, 10000, agentOwner);
        assertEq(usdc.balanceOf(agentOwner), 8500);
        assertEq(usdc.balanceOf(keeper),     500);
        assertEq(usdc.balanceOf(zhgg),       500);
        assertEq(usdc.balanceOf(commons),    500);
    }

    function test_splitERC20_emitsEventWithTag() public {
        bytes32 tag = bytes32("audit-job-123");
        vm.expectEmit(true, true, false, true);
        emit Split(agentOwner, address(usdc), 100e6, 85e6, 5e6, 5e6, 5e6, tag);
        vm.prank(payer);
        splitter.splitERC20WithTag(usdc, 100e6, agentOwner, tag);
    }

    function test_splitERC20_zeroAmountReverts() public {
        vm.prank(payer);
        vm.expectRevert(FeeSplitter.ZeroAmount.selector);
        splitter.splitERC20(usdc, 0, agentOwner);
    }

    function test_splitERC20_zeroOwnerReverts() public {
        vm.prank(payer);
        vm.expectRevert(FeeSplitter.ZeroAddress.selector);
        splitter.splitERC20(usdc, 100, address(0));
    }

    // ----- native -----

    function test_splitNative_distributes85_5_5_5() public {
        vm.prank(payer);
        splitter.splitNative{value: 1 ether}(agentOwner);
        assertEq(agentOwner.balance, 0.85 ether);
        assertEq(keeper.balance,     0.05 ether);
        assertEq(zhgg.balance,       0.05 ether);
        assertEq(commons.balance,    0.05 ether);
    }

    // ----- pull-payment escrow for failing native recipients -----

    function test_splitNative_revertingRecipientEscrowsLeg() public {
        RejectingRecipient bad = new RejectingRecipient();
        // Redeploy splitter with a reverting commons recipient so we can
        // exercise the failure path on a real address that explicitly
        // rejects ETH.
        FeeSplitter spl = new FeeSplitter(keeper, zhgg, address(bad));
        vm.deal(payer, 10 ether);

        vm.prank(payer);
        spl.splitNative{value: 1 ether}(agentOwner);

        // Working recipients still receive their cut.
        assertEq(agentOwner.balance, 0.85 ether);
        assertEq(keeper.balance,     0.05 ether);
        assertEq(zhgg.balance,       0.05 ether);
        // Reverting recipient's leg is escrowed, not lost.
        assertEq(spl.pendingNative(address(bad)), 0.05 ether);
        assertEq(address(bad).balance,            0);
    }

    function test_claimNative_pullsEscrowedLeg() public {
        RejectingRecipient bad = new RejectingRecipient();
        FeeSplitter spl = new FeeSplitter(keeper, zhgg, address(bad));
        vm.deal(payer, 10 ether);
        vm.prank(payer);
        spl.splitNative{value: 1 ether}(agentOwner);

        // Recipient flips to accepting-mode and claims.
        bad.setAccepting(true);
        vm.prank(address(bad));
        spl.claimNative();
        assertEq(address(bad).balance, 0.05 ether);
        assertEq(spl.pendingNative(address(bad)), 0);
    }

    function test_claimNative_revertsWhenNoPending() public {
        vm.prank(keeper);
        vm.expectRevert(FeeSplitter.NoPendingNative.selector);
        splitter.claimNative();
    }

    function test_splitNative_doesNotBrickWhenAgentOwnerReverts() public {
        // The agent owner is per-call attacker-controlled — confirm a
        // malicious owner cannot block the keeper/zhgg/commons legs.
        RejectingRecipient badOwner = new RejectingRecipient();
        vm.prank(payer);
        splitter.splitNative{value: 1 ether}(address(badOwner));

        assertEq(keeper.balance,  0.05 ether);
        assertEq(zhgg.balance,    0.05 ether);
        assertEq(commons.balance, 0.05 ether);
        assertEq(splitter.pendingNative(address(badOwner)), 0.85 ether);
    }

    // ----- ERC-8021 calldata-suffix path -----

    bytes16 internal constant MAGIC = 0x80218021802180218021802180218021;

    /// @dev Build a Schema 0 suffix for `codesCsv` (comma-joined ASCII).
    function _suffix0(string memory codesCsv) internal pure returns (bytes memory) {
        bytes memory codes = bytes(codesCsv);
        require(codes.length <= 255, "codes too long");
        return abi.encodePacked(codes, uint8(codes.length), uint8(0), MAGIC);
    }

    function test_erc8021_detectsSuffixAndSplits() public {
        bytes memory suffix = _suffix0("zhgg,baseapp");
        bytes memory call = abi.encodeCall(
            FeeSplitter.splitERC20Erc8021,
            (usdc, 100e6, agentOwner)
        );
        bytes memory data = bytes.concat(call, suffix);

        vm.prank(payer);
        (bool ok,) = address(splitter).call(data);
        assertTrue(ok, "call failed");

        assertEq(usdc.balanceOf(agentOwner), 85e6);
        assertEq(usdc.balanceOf(keeper),     5e6);
        assertEq(usdc.balanceOf(zhgg),       5e6);
        assertEq(usdc.balanceOf(commons),    5e6);
    }

    function test_erc8021_revertsWhenSuffixMissing() public {
        bytes memory call = abi.encodeCall(
            FeeSplitter.splitERC20Erc8021,
            (usdc, 100e6, agentOwner)
        );
        vm.prank(payer);
        (bool ok, bytes memory ret) = address(splitter).call(call);
        assertFalse(ok);
        assertEq(bytes4(ret), FeeSplitter.MissingERC8021Suffix.selector);
    }

    function test_erc8021_revertsWhenMagicCorrupted() public {
        bytes memory bad = _suffix0("zhgg");
        bad[bad.length - 1] = 0x00; // flip last byte of magic
        bytes memory call = abi.encodeCall(
            FeeSplitter.splitERC20Erc8021,
            (usdc, 100e6, agentOwner)
        );
        vm.prank(payer);
        (bool ok,) = address(splitter).call(bytes.concat(call, bad));
        assertFalse(ok);
    }

    function test_erc8021_emitsAttributionEvent() public {
        bytes memory suffix = _suffix0("zhgg");
        bytes memory call = abi.encodeCall(
            FeeSplitter.splitERC20Erc8021,
            (usdc, 100e6, agentOwner)
        );
        bytes memory data = bytes.concat(call, suffix);

        vm.recordLogs();
        vm.prank(payer);
        (bool ok,) = address(splitter).call(data);
        assertTrue(ok);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawAttribution;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("ERC8021Attribution(bytes32,string[],uint8)")) {
                sawAttribution = true;
                break;
            }
        }
        assertTrue(sawAttribution, "no attribution event");
    }

    function test_erc8021_legacyTagPathStillWorks() public {
        // Back-compat: splitERC20WithTag must still work when caller has not
        // migrated to the suffix flow.
        bytes32 tag = bytes32("legacy-app-code");
        vm.prank(payer);
        splitter.splitERC20WithTag(usdc, 100e6, agentOwner, tag);
        assertEq(usdc.balanceOf(agentOwner), 85e6);
    }

    function test_erc8021_libraryDecodesCodes() public pure {
        bytes memory body = abi.encodePacked(bytes("zhgg,baseapp"), uint8(12));
        string[] memory codes = ERC8021Suffix.decodeSchema0(body);
        assertEq(codes.length, 2);
        assertEq(codes[0], "zhgg");
        assertEq(codes[1], "baseapp");
    }

    /// SOL↔TS parity: the bytes a TS encoder produces for a fixed
    /// codes-set must hash to the same suffixTag as the on-chain
    /// `keccak256(suffix)`. Locked against the same fixture in
    /// `apps/demo/test/erc8021-suffix.test.ts`.
    function test_erc8021_suffixTag_ts_parity_fixture() public {
        // Fixture: codes = ["zhgg","baseapp"], schemaId = 0.
        // Expected raw suffix (29 bytes):
        //   "zhgg,baseapp" (12) || 0x0c (codesLen) || 0x00 (schemaId) || MAGIC (16)
        bytes memory expectedSuffix = hex"7a6867672c626173656170700c0080218021802180218021802180218021";
        bytes32 expectedTag = 0x93f18506612d8338d72a3ca6bef0482ea7f37bcddb5c4e4fb708cd0d99da7504;

        assertEq(keccak256(expectedSuffix), expectedTag, "raw suffix hash drift");

        // Build a calldata buffer that ends with this suffix and verify
        // the library extracts the same tag from it.
        bytes memory call = abi.encodeCall(
            FeeSplitter.splitERC20Erc8021,
            (usdc, 100e6, agentOwner)
        );
        bytes memory data = bytes.concat(call, expectedSuffix);

        vm.recordLogs();
        vm.prank(payer);
        (bool ok,) = address(splitter).call(data);
        assertTrue(ok, "split call failed");

        // Walk the logs for the Split event and read its attributionTag.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 emittedTag;
        for (uint256 i = 0; i < logs.length; ++i) {
            // Split(address,address,uint256,uint256,uint256,uint256,uint256,bytes32)
            if (
                logs[i].topics[0]
                    == keccak256(
                        "Split(address,address,uint256,uint256,uint256,uint256,uint256,bytes32)"
                    )
            ) {
                (,,,,, emittedTag) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, bytes32));
                break;
            }
        }
        assertEq(emittedTag, expectedTag, "splitter emitted wrong attributionTag");
    }
}

/// Minimal contract that rejects ETH unless explicitly enabled.
contract RejectingRecipient {
    bool public accepting;

    function setAccepting(bool v) external {
        accepting = v;
    }

    receive() external payable {
        require(accepting, "rejecting");
    }
}
