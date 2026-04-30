// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

contract AgentRegistryTest is Test {
    AgentRegistry internal reg;

    address internal alice = address(0xA11CE);
    address internal bob   = address(0xB0B);
    address internal carol = address(0xCAFE);

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event NewFeedback(
        uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex,
        int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2,
        string endpoint, string feedbackURI, bytes32 feedbackHash
    );
    event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex);

    function setUp() public {
        reg = new AgentRegistry();
    }

    // ----- register -----

    function test_register_assignsSequentialIds() public {
        AgentRegistry.MetadataEntry[] memory empty = new AgentRegistry.MetadataEntry[](0);
        vm.prank(alice);
        uint256 a = reg.register("ipfs://a", empty);
        vm.prank(bob);
        uint256 b = reg.register("ipfs://b", empty);
        assertEq(a, 1);
        assertEq(b, 2);
        assertEq(reg.ownerOf(a), alice);
        assertEq(reg.ownerOf(b), bob);
    }

    function test_register_storesMetadata() public {
        AgentRegistry.MetadataEntry[] memory meta = new AgentRegistry.MetadataEntry[](2);
        meta[0] = AgentRegistry.MetadataEntry({metadataKey: "inft",  metadataValue: bytes("0xAGENTNFT:1")});
        meta[1] = AgentRegistry.MetadataEntry({metadataKey: "ens",   metadataValue: bytes("audit.zhgg.eth")});
        vm.prank(alice);
        uint256 id = reg.register("ipfs://reg", meta);
        assertEq(string(reg.getMetadata(id, "inft")),  "0xAGENTNFT:1");
        assertEq(string(reg.getMetadata(id, "ens")),   "audit.zhgg.eth");
    }

    function test_setMetadata_ownerOnly() public {
        AgentRegistry.MetadataEntry[] memory empty = new AgentRegistry.MetadataEntry[](0);
        vm.prank(alice);
        uint256 id = reg.register("ipfs://", empty);
        vm.prank(bob);
        vm.expectRevert(AgentRegistry.NotAgentOwner.selector);
        reg.setMetadata(id, "ens", bytes("attacker.eth"));
    }

    function test_setAgentURI_ownerOnly() public {
        AgentRegistry.MetadataEntry[] memory empty = new AgentRegistry.MetadataEntry[](0);
        vm.prank(alice);
        uint256 id = reg.register("ipfs://", empty);
        vm.prank(alice);
        reg.setAgentURI(id, "ipfs://updated");
        assertEq(reg.tokenURI(id), "ipfs://updated");
        vm.prank(bob);
        vm.expectRevert(AgentRegistry.NotAgentOwner.selector);
        reg.setAgentURI(id, "ipfs://hijacked");
    }

    // ----- agent wallet -----

    function test_setAgentWallet_resetsOnTransfer() public {
        AgentRegistry.MetadataEntry[] memory empty = new AgentRegistry.MetadataEntry[](0);
        vm.prank(alice);
        uint256 id = reg.register("ipfs://", empty);
        vm.prank(alice);
        reg.setAgentWallet(id, carol);
        assertEq(reg.getAgentWallet(id), carol);

        vm.prank(alice);
        reg.transferFrom(alice, bob, id);
        assertEq(reg.getAgentWallet(id), address(0));
    }

    // ----- feedback -----

    function test_giveFeedback_emitsAndStores() public {
        AgentRegistry.MetadataEntry[] memory empty = new AgentRegistry.MetadataEntry[](0);
        vm.prank(alice);
        uint256 id = reg.register("ipfs://", empty);

        vm.prank(bob);
        reg.giveFeedback(id, 100, 0, "audit", "eu-ai-act", "https://api", "ipfs://fb1", bytes32(uint256(1)));

        assertEq(reg.getLastIndex(id, bob), 1);
        (int128 v, uint8 d, string memory t1, string memory t2, bool revoked) = reg.readFeedback(id, bob, 1);
        assertEq(v, 100);
        assertEq(d, 0);
        assertEq(t1, "audit");
        assertEq(t2, "eu-ai-act");
        assertFalse(revoked);
    }

    function test_giveFeedback_selfFeedbackForbidden() public {
        AgentRegistry.MetadataEntry[] memory empty = new AgentRegistry.MetadataEntry[](0);
        vm.prank(alice);
        uint256 id = reg.register("ipfs://", empty);

        vm.prank(alice);
        vm.expectRevert(AgentRegistry.SelfFeedbackForbidden.selector);
        reg.giveFeedback(id, 100, 0, "x", "y", "", "", bytes32(0));
    }

    function test_giveFeedback_unknownAgentReverts() public {
        vm.prank(bob);
        vm.expectRevert(AgentRegistry.AgentNotFound.selector);
        reg.giveFeedback(999, 100, 0, "x", "y", "", "", bytes32(0));
    }

    function test_revokeFeedback_marksRevoked() public {
        AgentRegistry.MetadataEntry[] memory empty = new AgentRegistry.MetadataEntry[](0);
        vm.prank(alice);
        uint256 id = reg.register("ipfs://", empty);
        vm.prank(bob);
        reg.giveFeedback(id, 100, 0, "x", "y", "", "", bytes32(0));
        vm.prank(bob);
        reg.revokeFeedback(id, 1);
        (,,,, bool revoked) = reg.readFeedback(id, bob, 1);
        assertTrue(revoked);
    }

    function test_revokeFeedback_invalidIndexReverts() public {
        AgentRegistry.MetadataEntry[] memory empty = new AgentRegistry.MetadataEntry[](0);
        vm.prank(alice);
        uint256 id = reg.register("ipfs://", empty);
        vm.prank(bob);
        vm.expectRevert(AgentRegistry.InvalidFeedbackIndex.selector);
        reg.revokeFeedback(id, 1);
    }

    function test_clients_listsUniqueFeedbackGivers() public {
        AgentRegistry.MetadataEntry[] memory empty = new AgentRegistry.MetadataEntry[](0);
        vm.prank(alice);
        uint256 id = reg.register("ipfs://", empty);
        vm.prank(bob);
        reg.giveFeedback(id, 1, 0, "x", "y", "", "", bytes32(0));
        vm.prank(bob);
        reg.giveFeedback(id, 2, 0, "x", "y", "", "", bytes32(0));
        vm.prank(carol);
        reg.giveFeedback(id, 3, 0, "x", "y", "", "", bytes32(0));
        address[] memory clients = reg.getClients(id);
        assertEq(clients.length, 2);
    }
}
