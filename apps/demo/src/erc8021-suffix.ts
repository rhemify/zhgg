/// ERC-8021 calldata-suffix encoder + detector. Used to append the
/// canonical attribution suffix to calldata so the on-chain
/// `FeeSplitter.splitERC20Erc8021` can credit the originating app.
///
/// IMPORTANT: viem's `writeContract` re-encodes from the abi every call,
/// stripping any extra trailing bytes. To send a tagged call you must
/// build calldata manually with `encodeFunctionData` then call
/// `walletClient.sendTransaction({ to, data })`. The chain accepts
/// excess calldata; the on-chain library reads the trailing 16 bytes
/// and ignores any envelope mismatch.

import { type Hex, bytesToHex, concat, hexToBytes, size, toHex } from 'viem';

/// 16-byte trailing magic — last bytes of every valid 8021 suffix.
export const ERC8021_MAGIC = '0x80218021802180218021802180218021' as const satisfies Hex;

export const SCHEMA_ID = { CANONICAL: 0, CUSTOM_REGISTRY: 1, CBOR: 2 } as const;

/// Encode a Schema 0 (canonical registry) suffix.
///
///   [ codesAscii N B ][ codesLength 1B ][ schemaId=0 1B ][ MAGIC 16B ]
// Printable ASCII excluding the comma delimiter (0x2c). Single regex —
// the delimiter check is encoded in the character class so we don't
// need a follow-up `includes(',')` pass.
const VALID_CODE = /^[\x20-\x2b\x2d-\x7e]+$/;

export function encodeSchema0Suffix(codes: readonly string[]): Hex {
  if (codes.length === 0) throw new Error('erc8021: codes must be non-empty');
  for (const c of codes) {
    if (!VALID_CODE.test(c)) {
      throw new Error(`erc8021: code "${c}" must be printable ASCII without commas`);
    }
  }

  const csv = codes.join(',');
  const codesHex = toHex(csv); // ASCII -> hex
  const codesLen = size(codesHex);
  if (codesLen > 0xff) {
    throw new Error(`erc8021: codes payload ${codesLen}B exceeds 255B limit`);
  }

  return concat([
    codesHex,
    toHex(codesLen, { size: 1 }),
    toHex(SCHEMA_ID.CANONICAL, { size: 1 }),
    ERC8021_MAGIC,
  ]);
}

/// Append a suffix to viem-encoded calldata. No abi validation —
/// caller is expected to have built `calldata` via `encodeFunctionData`.
export function appendSuffix(calldata: Hex, suffix: Hex): Hex {
  return concat([calldata, suffix]);
}

/// One-shot helper: append a Schema 0 suffix carrying `codes`.
export function withErc8021<T extends Hex>(calldata: T, codes: readonly string[]): Hex {
  return appendSuffix(calldata, encodeSchema0Suffix(codes));
}

/// Detect + extract a suffix from raw tx input. Mirrors the on-chain
/// library byte-for-byte — used by the demo CLI to verify what the
/// contract will see.
export function detectSuffix(
  data: Hex
):
  | { found: false }
  | { found: true; schemaId: number; codes: string[]; suffix: Hex } {
  const bytes = hexToBytes(data);
  if (bytes.length < 18) return { found: false };

  const tail = bytes.slice(bytes.length - 16);
  const magicBytes = hexToBytes(ERC8021_MAGIC);
  for (let i = 0; i < 16; i++) {
    if (tail[i] !== magicBytes[i]) return { found: false };
  }

  const schemaId = bytes[bytes.length - 17]!;
  const codesLen = bytes[bytes.length - 18]!;
  const start = bytes.length - 18 - codesLen;
  if (start < 4) return { found: false };

  const codesAscii = new TextDecoder().decode(bytes.slice(start, start + codesLen));
  const codes = codesAscii.length === 0 ? [] : codesAscii.split(',');
  const suffix = bytesToHex(bytes.slice(start));

  return { found: true, schemaId, codes, suffix };
}
