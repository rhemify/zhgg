// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";
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

    function test_splitERC20_dustGoesToOwner() public {
        // 7 wei: 0.35 → keeper, 0.35 → zhgg, 0.35 → commons (all floored to 0).
        // Owner should get the full 7.
        uint256 total = 7;
        vm.prank(payer);
        splitter.splitERC20(usdc, total, agentOwner);

        assertEq(usdc.balanceOf(agentOwner), 7);
        assertEq(usdc.balanceOf(keeper),     0);
        assertEq(usdc.balanceOf(zhgg),       0);
        assertEq(usdc.balanceOf(commons),    0);
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
}
