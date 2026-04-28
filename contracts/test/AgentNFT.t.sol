// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentNFT} from "../src/AgentNFT.sol";
import {IERC7857} from "../src/interfaces/IERC7857.sol";

/// @title AgentNFT.t.sol — unit tests for the ERC-7857 iNFT contract
contract AgentNFTTest is Test {
    AgentNFT internal nft;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCAFE);

    bytes internal constant MANIFEST = hex"deadbeef";

    // Mirror of the events under test (Foundry's expectEmit needs a local copy).
    event UsageAuthorized(uint256 indexed tokenId, address indexed user, bytes32 intentHash, uint256 royaltyPaid);
    event AuthorizationRevoked(uint256 indexed tokenId, address indexed user);
    event MemoryRootUpdated(uint256 indexed tokenId, bytes32 oldRoot, bytes32 newRoot);
    event IntelligentDataUpdated(uint256 indexed tokenId, bytes32 dataHash, string dataDescription);

    function setUp() public {
        nft = new AgentNFT();
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    // -----------------------------------------------------------------
    // mint
    // -----------------------------------------------------------------

    function test_mint_assignsSequentialIdsStartingAtOne() public {
        uint256 t1 = nft.mint(alice, MANIFEST);
        uint256 t2 = nft.mint(alice, MANIFEST);
        uint256 t3 = nft.mint(bob, MANIFEST);
        assertEq(t1, 1);
        assertEq(t2, 2);
        assertEq(t3, 3);
        assertEq(nft.nextTokenId(), 4);
    }

    function test_mint_setsOwnerCorrectly() public {
        uint256 tokenId = nft.mint(alice, MANIFEST);
        assertEq(nft.ownerOf(tokenId), alice);
    }

    function test_mint_storesCapabilityManifest() public {
        uint256 tokenId = nft.mint(alice, MANIFEST);
        assertEq(nft.capabilities(tokenId), MANIFEST);
    }

    // -----------------------------------------------------------------
    // authorizeUsage
    // -----------------------------------------------------------------

    function test_authorizeUsage_paysRoyaltyToOwner() public {
        uint256 tokenId = nft.mint(alice, MANIFEST);
        uint256 ownerBefore = alice.balance;

        vm.prank(bob);
        nft.authorizeUsage{value: 1 ether}(tokenId, keccak256("intent"));

        // 5% of 1 ether = 0.05 ether
        assertEq(alice.balance - ownerBefore, 0.05 ether);
    }

    function test_authorizeUsage_refundsExcessToCaller() public {
        uint256 tokenId = nft.mint(alice, MANIFEST);
        uint256 callerBefore = bob.balance;

        vm.prank(bob);
        nft.authorizeUsage{value: 1 ether}(tokenId, keccak256("intent"));

        // Bob should have paid only the 5% royalty.
        assertEq(callerBefore - bob.balance, 0.05 ether);
    }

    function test_authorizeUsage_recordsAuthorization() public {
        uint256 tokenId = nft.mint(alice, MANIFEST);
        assertFalse(nft.isAuthorized(tokenId, bob));
        vm.prank(bob);
        nft.authorizeUsage{value: 0.1 ether}(tokenId, keccak256("intent"));
        assertTrue(nft.isAuthorized(tokenId, bob));
    }

    function test_authorizeUsage_revertsOnNonexistentTokenId() public {
        vm.prank(bob);
        vm.expectRevert();
        nft.authorizeUsage{value: 0.1 ether}(999, keccak256("intent"));
    }

    function test_authorizeUsage_emitsEvent() public {
        uint256 tokenId = nft.mint(alice, MANIFEST);
        bytes32 ih = keccak256("intent");

        vm.expectEmit(true, true, false, true, address(nft));
        emit UsageAuthorized(tokenId, bob, ih, 0.05 ether);

        vm.prank(bob);
        nft.authorizeUsage{value: 1 ether}(tokenId, ih);
    }

    function test_authorizeUsage_zeroValueGrantsAuthorizationAndPaysNothing() public {
        uint256 tokenId = nft.mint(alice, MANIFEST);
        uint256 ownerBefore = alice.balance;
        vm.prank(bob);
        nft.authorizeUsage{value: 0}(tokenId, keccak256("intent"));
        assertTrue(nft.isAuthorized(tokenId, bob));
        assertEq(alice.balance, ownerBefore);
    }

    // -----------------------------------------------------------------
    // revokeAuthorization
    // -----------------------------------------------------------------

    function test_revokeAuthorization_onlyOwnerCanCall() public {
        uint256 tokenId = nft.mint(alice, MANIFEST);
        vm.prank(bob);
        nft.authorizeUsage{value: 0.1 ether}(tokenId, keccak256("intent"));

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSignature("NotTokenOwner(uint256,address)", tokenId, carol));
        nft.revokeAuthorization(tokenId, bob);
    }

    function test_revokeAuthorization_setsIsAuthorizedFalse() public {
        uint256 tokenId = nft.mint(alice, MANIFEST);
        vm.prank(bob);
        nft.authorizeUsage{value: 0.1 ether}(tokenId, keccak256("intent"));
        assertTrue(nft.isAuthorized(tokenId, bob));

        vm.expectEmit(true, true, false, false, address(nft));
        emit AuthorizationRevoked(tokenId, bob);

        vm.prank(alice);
        nft.revokeAuthorization(tokenId, bob);

        assertFalse(nft.isAuthorized(tokenId, bob));
    }

    // -----------------------------------------------------------------
    // updateMemoryRoot
    // -----------------------------------------------------------------

    function test_updateMemoryRoot_onlyOwnerCanUpdate() public {
        uint256 tokenId = nft.mint(alice, MANIFEST);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSignature("NotTokenOwner(uint256,address)", tokenId, bob));
        nft.updateMemoryRoot(tokenId, bytes32(uint256(1)));
    }

    function test_updateMemoryRoot_updatesValue() public {
        uint256 tokenId = nft.mint(alice, MANIFEST);
        bytes32 root = keccak256("root-1");
        vm.prank(alice);
        nft.updateMemoryRoot(tokenId, root);
        assertEq(nft.memoryRoot(tokenId), root);
    }

    function test_updateMemoryRoot_emitsEventWithOldAndNewRoot() public {
        uint256 tokenId = nft.mint(alice, MANIFEST);
        bytes32 first = keccak256("root-1");
        bytes32 second = keccak256("root-2");

        vm.expectEmit(true, false, false, true, address(nft));
        emit MemoryRootUpdated(tokenId, bytes32(0), first);
        vm.prank(alice);
        nft.updateMemoryRoot(tokenId, first);

        vm.expectEmit(true, false, false, true, address(nft));
        emit MemoryRootUpdated(tokenId, first, second);
        vm.prank(alice);
        nft.updateMemoryRoot(tokenId, second);
    }

    // -----------------------------------------------------------------
    // updateData
    // -----------------------------------------------------------------

    function test_updateData_onlyOwnerCanCall() public {
        uint256 tokenId = nft.mint(alice, MANIFEST);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSignature("NotTokenOwner(uint256,address)", tokenId, bob));
        nft.updateData(tokenId, keccak256("blob"), "0g://storage/abc");
    }

    function test_updateData_appendsToIntelligentDatasOf() public {
        uint256 tokenId = nft.mint(alice, MANIFEST);
        bytes32 hash1 = keccak256("blob-1");
        bytes32 hash2 = keccak256("blob-2");

        vm.startPrank(alice);
        nft.updateData(tokenId, hash1, "0g://storage/one");
        nft.updateData(tokenId, hash2, "0g://storage/two");
        vm.stopPrank();

        IERC7857.IntelligentData[] memory rows = nft.intelligentDatasOf(tokenId);
        assertEq(rows.length, 2);
        assertEq(rows[0].dataHash, hash1);
        assertEq(rows[0].dataDescription, "0g://storage/one");
        assertEq(rows[1].dataHash, hash2);
        assertEq(rows[1].dataDescription, "0g://storage/two");
    }

    // -----------------------------------------------------------------
    // iTransferFrom
    // -----------------------------------------------------------------

    function test_iTransferFrom_emptyProofsReverts() public {
        uint256 tokenId = nft.mint(alice, MANIFEST);
        IERC7857.TransferValidityProof[] memory proofs = new IERC7857.TransferValidityProof[](0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("MissingTransferProofs()"));
        nft.iTransferFrom(alice, bob, tokenId, proofs);
    }

    function test_iTransferFrom_withProofsTransfersOwnership() public {
        uint256 tokenId = nft.mint(alice, MANIFEST);
        IERC7857.TransferValidityProof[] memory proofs = new IERC7857.TransferValidityProof[](1);
        proofs[0] = IERC7857.TransferValidityProof({commitment: keccak256("c"), signature: hex"01"});

        vm.prank(alice);
        nft.iTransferFrom(alice, bob, tokenId, proofs);

        assertEq(nft.ownerOf(tokenId), bob);
    }

    function test_iTransferFrom_v1Stub_blocksApprovedNonOwner() public {
        // Regression: in the v1 stub path any non-empty proof was accepted, so
        // an approved address could pull a token without real verification.
        // The stub now requires msg.sender == from.
        uint256 tokenId = nft.mint(alice, MANIFEST);
        vm.prank(alice);
        nft.approve(bob, tokenId);

        IERC7857.TransferValidityProof[] memory proofs = new IERC7857.TransferValidityProof[](1);
        proofs[0] = IERC7857.TransferValidityProof({commitment: keccak256("c"), signature: hex"01"});

        vm.prank(bob); // approved, but not the owner
        vm.expectRevert(abi.encodeWithSignature("TransferDisabled()"));
        nft.iTransferFrom(alice, bob, tokenId, proofs);

        assertEq(nft.ownerOf(tokenId), alice);
    }

    function test_plainTransferFrom_isDisabled() public {
        uint256 tokenId = nft.mint(alice, MANIFEST);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("TransferDisabled()"));
        nft.transferFrom(alice, bob, tokenId);
    }

    function test_plainSafeTransferFrom_isDisabled() public {
        uint256 tokenId = nft.mint(alice, MANIFEST);

        // 3-arg overload — delegates internally to the 4-arg version, which reverts.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("TransferDisabled()"));
        nft.safeTransferFrom(alice, bob, tokenId);

        // 4-arg overload — directly overridden to revert.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("TransferDisabled()"));
        nft.safeTransferFrom(alice, bob, tokenId, hex"");
    }
}
