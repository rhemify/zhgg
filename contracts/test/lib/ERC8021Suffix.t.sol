// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC8021Suffix} from "../../src/lib/ERC8021Suffix.sol";
import {FeeSplitter} from "../../src/FeeSplitter.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Local stand-in for the test ERC-20 already used by
///      contracts/test/FeeSplitter.t.sol. Duplicated to keep this file
///      self-contained per the task constraint of not touching
///      FeeSplitter.t.sol.
contract MockUSDC8021 is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function decimals() public pure override returns (uint8) { return 6; }
}

/// @dev Thin harness — `ERC8021Suffix.detect` is `internal`, so we need
///      a contract surface to call it from the test runner. Keeps the
///      library's API unchanged while letting us assert revert behavior
///      in isolation, decoupled from FeeSplitter's flow.
contract ERC8021SuffixHarness {
    function detect(bytes calldata data)
        external
        pure
        returns (bool found, uint8 schemaId, bytes memory body)
    {
        return ERC8021Suffix.detect(data);
    }
}

contract ERC8021SuffixTest is Test {
    ERC8021SuffixHarness internal harness;

    bytes16 internal constant MAGIC = 0x80218021802180218021802180218021;

    /// @dev Pad the payload with a 4-byte selector + arg word so the
    ///      "must leave 4 bytes for the function selector" guard inside
    ///      `detect` is always satisfied — these tests are about schema
    ///      dispatch, not the selector-headroom edge case.
    bytes internal constant FAKE_CALL_PREFIX =
        hex"deadbeef0000000000000000000000000000000000000000000000000000000000000000";

    function setUp() public {
        harness = new ERC8021SuffixHarness();
    }

    /// @dev Build a suffix for an arbitrary schemaId. The body shape
    ///      (codes + codesLen byte) matches Schema 0; the schemaId byte
    ///      is what differentiates them on the wire. v1 should only
    ///      accept schemaId=0 — any other value is a contract-level
    ///      error.
    function _suffix(uint8 schemaId, string memory codesCsv) internal pure returns (bytes memory) {
        bytes memory codes = bytes(codesCsv);
        require(codes.length <= 255, "codes too long");
        return abi.encodePacked(codes, uint8(codes.length), schemaId, MAGIC);
    }

    // ----- Schema 0: still works (regression guard) -----

    function test_detect_schema0_returnsBodyAndFlags() public view {
        bytes memory data = bytes.concat(FAKE_CALL_PREFIX, _suffix(0, "zhgg,baseapp"));
        (bool found, uint8 schemaId, bytes memory body) = harness.detect(data);
        assertTrue(found, "schema 0 should be detected");
        assertEq(schemaId, 0, "schemaId mismatch");
        // Body = codes (12B) || codesLen (1B) — see library NatSpec.
        assertEq(body.length, 13, "body length mismatch");
        assertEq(uint8(body[body.length - 1]), 12, "body codesLen byte mismatch");
    }

    function test_decodeSchema0_extractsCodesCorrectly() public pure {
        // Re-build the body shape `detect` would hand back for
        // ["zhgg","baseapp"] and confirm decodeSchema0 recovers the
        // ASCII codes verbatim.
        bytes memory body = abi.encodePacked(bytes("zhgg,baseapp"), uint8(12));
        string[] memory codes = ERC8021Suffix.decodeSchema0(body);
        assertEq(codes.length, 2, "expected 2 codes");
        assertEq(codes[0], "zhgg");
        assertEq(codes[1], "baseapp");
    }

    // ----- Schema 1: rejected with UnsupportedSchema(1) -----

    function test_detect_schema1_revertsUnsupportedSchema() public {
        bytes memory data = bytes.concat(FAKE_CALL_PREFIX, _suffix(1, "zhgg"));
        vm.expectRevert(abi.encodeWithSelector(ERC8021Suffix.UnsupportedSchema.selector, uint8(1)));
        harness.detect(data);
    }

    // ----- Schema 2: rejected with UnsupportedSchema(2) -----

    function test_detect_schema2_revertsUnsupportedSchema() public {
        bytes memory data = bytes.concat(FAKE_CALL_PREFIX, _suffix(2, "zhgg"));
        vm.expectRevert(abi.encodeWithSelector(ERC8021Suffix.UnsupportedSchema.selector, uint8(2)));
        harness.detect(data);
    }

    // ----- Sanity: no magic = no schema dispatch (silent miss is OK) -----

    function test_detect_noMagic_returnsFalseWithoutReverting() public view {
        // Calldata that doesn't end with MAGIC must not trigger schema
        // dispatch at all — `found=false` is the right answer for
        // calls that simply chose not to attach a tag.
        bytes memory data = hex"deadbeef00000000000000000000000000000000000000000000000000000000";
        (bool found, uint8 schemaId,) = harness.detect(data);
        assertFalse(found, "no magic, no detection");
        assertEq(schemaId, 0, "schemaId should be zeroed when not found");
    }

    // ----- Boundary: large unknown schemaId still reverts cleanly -----

    function test_detect_arbitraryUnknownSchemaId_reverts() public {
        bytes memory data = bytes.concat(FAKE_CALL_PREFIX, _suffix(99, "zhgg"));
        vm.expectRevert(abi.encodeWithSelector(ERC8021Suffix.UnsupportedSchema.selector, uint8(99)));
        harness.detect(data);
    }
}

/// @dev End-to-end consumer test: when a Schema-1 suffix is appended to
///      a real `splitERC20Erc8021` call, the library's
///      `UnsupportedSchema(1)` revert MUST bubble all the way up to the
///      caller — proving the no-silent-drop guarantee at the integration
///      boundary, not just in library isolation.
contract ERC8021SuffixFeeSplitterBubbleTest is Test {
    FeeSplitter internal splitter;
    MockUSDC8021 internal usdc;

    address internal keeper      = address(0xBEEF);
    address internal zhgg        = address(0xCAFE);
    address internal commons     = address(0xDADA);
    address internal payer       = address(0x1111);
    address internal agentOwner  = address(0x2222);

    bytes16 internal constant MAGIC = 0x80218021802180218021802180218021;

    function setUp() public {
        splitter = new FeeSplitter(keeper, zhgg, commons);
        usdc = new MockUSDC8021();
        usdc.mint(payer, 1_000_000e6);
        vm.prank(payer);
        usdc.approve(address(splitter), type(uint256).max);
    }

    function _suffix(uint8 schemaId, string memory codesCsv) internal pure returns (bytes memory) {
        bytes memory codes = bytes(codesCsv);
        return abi.encodePacked(codes, uint8(codes.length), schemaId, MAGIC);
    }

    /// Bubbled revert: a real Erc8021 call carrying a Schema-1 suffix
    /// must fail with `UnsupportedSchema(1)`, not silently drop the
    /// attribution and continue the split. This is the integration
    /// guarantee the spec asks for.
    function test_splitERC20Erc8021_schema1Suffix_bubblesUnsupportedSchema() public {
        bytes memory call = abi.encodeCall(
            FeeSplitter.splitERC20Erc8021,
            (usdc, 100e6, agentOwner)
        );
        bytes memory data = bytes.concat(call, _suffix(1, "zhgg"));

        vm.prank(payer);
        (bool ok, bytes memory ret) = address(splitter).call(data);
        assertFalse(ok, "schema 1 must revert");
        assertEq(
            bytes4(ret),
            ERC8021Suffix.UnsupportedSchema.selector,
            "expected UnsupportedSchema selector"
        );

        // Decode the revert payload and confirm the bubbled schemaId is
        // the one the caller actually sent (1) — proves the error came
        // from the schema dispatch and not some other revert path.
        bytes memory tail = new bytes(ret.length - 4);
        for (uint256 i = 0; i < tail.length; ++i) tail[i] = ret[4 + i];
        uint8 reportedId = abi.decode(tail, (uint8));
        assertEq(reportedId, 1, "bubbled schemaId mismatch");

        // No funds should have moved on the reverting path.
        assertEq(usdc.balanceOf(agentOwner), 0, "agent owner must not have received funds");
        assertEq(usdc.balanceOf(address(splitter)), 0, "splitter must not have escrowed funds");
    }
}
