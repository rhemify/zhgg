// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ENSRegistrar, INameWrapper} from "../src/ENSRegistrar.sol";

/// @notice Minimal NameWrapper mock for unit tests. Real ENS NameWrapper is
///         only available on mainnet/Sepolia; we simulate the surface we use.
contract MockNameWrapper is INameWrapper {
    mapping(address => mapping(address => bool)) public approvals;
    mapping(bytes32 => address) public subnodeOwners;

    function setApprovalForAll(address operator, bool approved) external {
        approvals[msg.sender][operator] = approved;
    }

    function isApprovedForAll(address account, address operator) external view returns (bool) {
        return approvals[account][operator];
    }

    function setSubnodeOwner(
        bytes32 parentNode,
        string calldata label,
        address owner,
        uint32 /*fuses*/,
        uint64 /*expiry*/
    ) external returns (bytes32 node) {
        bytes32 labelhash = keccak256(bytes(label));
        node = keccak256(abi.encodePacked(parentNode, labelhash));
        subnodeOwners[node] = owner;
    }
}

contract ENSRegistrarTest is Test {
    ENSRegistrar internal reg;
    MockNameWrapper internal wrapper;
    bytes32 internal constant ZHGG_PARENT = keccak256("zhgg.eth.parent.fake");

    address internal deployer = address(this);
    address internal alice = address(0xA11CE);
    address internal bob   = address(0xB0B);

    event SubnameMinted(string label, bytes32 indexed labelhash, address indexed owner, bytes32 node);

    function setUp() public {
        wrapper = new MockNameWrapper();
        reg = new ENSRegistrar(wrapper, ZHGG_PARENT);
        // Approve the registrar from the deployer (== owner).
        wrapper.setApprovalForAll(address(reg), true);
    }

    // ----- mint (owner) -----

    function test_mintSubname_succeedsForOwner() public {
        bytes32 node = reg.mintSubname("audit", alice);
        assertEq(wrapper.subnodeOwners(node), alice);
        assertEq(reg.labelClaimedBy(keccak256(bytes("audit"))), alice);
    }

    function test_mintSubname_emitsEvent() public {
        vm.expectEmit(false, true, true, false);
        emit SubnameMinted("audit", keccak256(bytes("audit")), alice, bytes32(0));
        reg.mintSubname("audit", alice);
    }

    function test_mintSubname_revertsOnDuplicateLabel() public {
        reg.mintSubname("audit", alice);
        vm.expectRevert(ENSRegistrar.LabelAlreadyClaimed.selector);
        reg.mintSubname("audit", bob);
    }

    function test_mintSubname_revertsWhenNotApproved() public {
        wrapper.setApprovalForAll(address(reg), false);
        vm.expectRevert(ENSRegistrar.NotApprovedForAll.selector);
        reg.mintSubname("audit", alice);
    }

    function test_mintSubname_emptyLabelReverts() public {
        vm.expectRevert(ENSRegistrar.EmptyLabel.selector);
        reg.mintSubname("", alice);
    }

    function test_mintSubname_nonOwnerReverts() public {
        vm.prank(alice);
        vm.expectRevert();
        reg.mintSubname("hijacked", alice);
    }

    // ----- public mint -----

    function test_publicMint_disabledByDefault() public {
        vm.prank(alice);
        vm.expectRevert(ENSRegistrar.PublicMintDisabled.selector);
        reg.publicMintSubname("alice");
    }

    function test_publicMint_worksWhenEnabled() public {
        reg.setPublicMintEnabled(true);
        vm.prank(alice);
        bytes32 node = reg.publicMintSubname("alice");
        assertEq(wrapper.subnodeOwners(node), alice);
    }
}
