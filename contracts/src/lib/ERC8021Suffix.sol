// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  ERC8021Suffix — calldata-suffix detection for ERC-8021 attribution
/// @notice Pure-Solidity helpers for parsing the ERC-8021 attribution
///         suffix appended to the END of `msg.data` by callers who want
///         on-chain credit for their app code without taking up a
///         function argument slot. All functions are `internal` so the
///         consuming contract inlines them at compile time — no extra
///         deployment, no external CALL.
/// @dev    Suffix layout (parsed RIGHT-to-LEFT from end of `msg.data`):
///
///         [ ... selector + abi-args ... ][ schema body ][ schemaId 1B ][ MAGIC 16B ]
///
///         Schema 0 (canonical registry): body = [codes ASCII N B][codesLen 1B]
///         Schema 1 (custom registry):    body = [registry 20B][codes ASCII N B][codesLen 1B]
///
///         The 16-byte magic anchors the LAST 16 bytes. Off-chain
///         indexers (Dune, subgraphs) detect the suffix by reading the
///         tail of `tx.input` — this library mirrors that read so the
///         on-chain attribution tag is content-addressable: any indexer
///         can re-derive `keccak256(suffix)` from the original tx input
///         and match it back to the contract's emitted event.
library ERC8021Suffix {
    /// @notice Magic marker — always the trailing 16 bytes of any 8021 suffix.
    bytes16 internal constant MAGIC = 0x80218021802180218021802180218021;

    /// @notice 16 (magic) + 1 (schemaId) + 1 (codesLength) = 18 minimum.
    uint256 internal constant MIN_SUFFIX_LEN = 18;
    uint256 internal constant MAGIC_LEN = 16;

    /// @notice Detect a valid ERC-8021 suffix at the end of `data`.
    /// @return found     True iff trailing 16 bytes match MAGIC and the
    ///                   declared body fits within `data` ahead of a
    ///                   non-empty 4-byte selector.
    /// @return schemaId  Schema selector (0 = canonical, 1 = custom registry).
    /// @return body      Bytes BEFORE the schemaId+magic, with the
    ///                   length-prefix included. Caller picks a decoder.
    function detect(bytes calldata data)
        internal
        pure
        returns (bool found, uint8 schemaId, bytes memory body)
    {
        if (data.length < MIN_SUFFIX_LEN) return (false, 0, "");

        bytes16 trailing = bytes16(data[data.length - MAGIC_LEN:]);
        if (trailing != MAGIC) return (false, 0, "");

        schemaId = uint8(data[data.length - MAGIC_LEN - 1]);
        uint8 codesLen = uint8(data[data.length - MAGIC_LEN - 2]);

        // Body length = codesLen (codes) + 1 (codesLength byte).
        uint256 bodyLen = uint256(codesLen) + 1;
        // suffixStart = where body begins. Must leave at least 4 bytes
        // ahead of it for the function selector, otherwise this is not
        // a valid call.
        if (data.length < MAGIC_LEN + 1 + bodyLen + 4) return (false, 0, "");
        uint256 suffixStart = data.length - MAGIC_LEN - 1 - bodyLen;

        body = data[suffixStart:data.length - MAGIC_LEN - 1];
        found = true;
    }

    /// @notice Decode Schema 0 body into ASCII codes.
    /// @dev    Body layout: [ codesAscii (N) ][ codesLen 1B ].
    ///         codesAscii is comma-delimited, e.g. "zhgg,baseapp".
    function decodeSchema0(bytes memory body) internal pure returns (string[] memory codes) {
        if (body.length < 1) return new string[](0);
        uint8 codesLen = uint8(body[body.length - 1]);
        if (uint256(codesLen) + 1 != body.length) return new string[](0);
        if (codesLen == 0) return new string[](0);

        // First pass: count commas to size the output array.
        uint256 n = 1;
        for (uint256 i = 0; i < codesLen; ++i) {
            if (body[i] == 0x2c /* ',' */) n++;
        }

        codes = new string[](n);
        uint256 idx = 0;
        uint256 start = 0;
        for (uint256 i = 0; i < codesLen; ++i) {
            if (body[i] == 0x2c) {
                codes[idx++] = _slice(body, start, i - start);
                start = i + 1;
            }
        }
        codes[idx] = _slice(body, start, codesLen - start);
    }

    /// @notice Hash the full suffix (body || schemaId || magic) for cheap
    ///         on-chain attribution-tag emission. Off-chain indexers join
    ///         the hash against the calldata-extracted suffix to confirm
    ///         the tag matches the original tx input verbatim.
    function suffixTag(bytes calldata data) internal pure returns (bytes32) {
        if (data.length < MIN_SUFFIX_LEN) return bytes32(0);
        if (bytes16(data[data.length - MAGIC_LEN:]) != MAGIC) return bytes32(0);
        uint8 codesLen = uint8(data[data.length - MAGIC_LEN - 2]);
        uint256 suffixLen = MAGIC_LEN + 1 + 1 + uint256(codesLen);
        if (data.length < suffixLen + 4) return bytes32(0);
        return keccak256(data[data.length - suffixLen:]);
    }

    function _slice(bytes memory src, uint256 start, uint256 len)
        private
        pure
        returns (string memory)
    {
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; ++i) out[i] = src[start + i];
        return string(out);
    }
}
