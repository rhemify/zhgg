/// ERC-8021 calldata-suffix encoder + detector. Used to append the
/// canonical attribution suffix to calldata so the on-chain
/// `FeeSplitter.splitERC20Erc8021` can credit the originating app.
///
/// Schemas:
///   - Schema 0 (canonical registry): comma-delimited ASCII codes.
///     Implemented inline — see `encodeSchema0Suffix` / `withErc8021`.
///   - Schema 2 (CBOR): structured `appCode` / `walletCode` /
///     `serviceCodes` per `docs/specs/EIP-8021.md`. Implemented via
///     ox's `Attribution.toDataSuffix` (the EIP's reference impl) —
///     see `encodeSchema2Suffix` / `withErc8021Schema2`.
///
/// IMPORTANT: viem's `writeContract` re-encodes from the abi every call,
/// stripping any extra trailing bytes. To send a tagged call you must
/// build calldata manually with `encodeFunctionData` then call
/// `walletClient.sendTransaction({ to, data })`. The chain accepts
/// excess calldata; the on-chain library reads the trailing 16 bytes
/// and ignores any envelope mismatch.

import { type Hex, bytesToHex, concat, hexToBytes, size, toHex } from 'viem';
import { Attribution } from 'ox/erc8021';

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

/// Schema 2 (CBOR-encoded) attribution shape — matches the EIP-8021
/// spec at `docs/specs/EIP-8021.md` and ox's `AttributionSchemaId2`.
/// All fields are optional per the spec; pass an empty object only if
/// you really mean "tagged but no entities" (the suffix still carries
/// the marker so off-chain indexers know it's an 8021 envelope).
export interface Schema2Attribution {
  appCode?: string;
  walletCode?: string;
  serviceCodes?: readonly string[];
  /// Custom registries keyed by entity type — `app` and/or `wallet`.
  registries?: {
    app?: { address: `0x${string}`; chainId: number };
    wallet?: { address: `0x${string}`; chainId: number };
  };
  metadata?: Record<string, unknown>;
}

/// Encode a Schema 2 (CBOR) suffix via ox's reference implementation.
///
///   [ CBOR-encoded map N B ][ schemaId=0x02 1B ][ MAGIC 16B ]
///
/// ox uses deterministic CBOR (sorted keys, definite-length) so two
/// calls with the same input produce byte-equal output — important
/// for round-trip tests and indexer determinism.
export function encodeSchema2Suffix(opts: Schema2Attribution): Hex {
  // ox's `id: 2` selects Schema 2; we leave it implicit by passing
  // schema-2-shaped fields, but spell it out so the type narrows
  // correctly inside ox.
  return Attribution.toDataSuffix({ ...opts, id: 2 }) as Hex;
}

/// One-shot helper: append a Schema 2 suffix to viem-encoded calldata.
/// Mirrors the shape of `withErc8021` for Schema 0.
export function withErc8021Schema2<T extends Hex>(
  calldata: T,
  opts: Schema2Attribution
): Hex {
  return appendSuffix(calldata, encodeSchema2Suffix(opts));
}

/// Detect + extract a suffix from raw tx input. For Schema 0 we mirror
/// the on-chain library byte-for-byte (used by the demo CLI to verify
/// what the contract will see). For Schema 2, we delegate to ox's
/// `Attribution.fromData` which handles the CBOR decode.
export function detectSuffix(
  data: Hex
):
  | { found: false }
  | { found: true; schemaId: 0; codes: string[]; suffix: Hex }
  | { found: true; schemaId: 2; attribution: Schema2Attribution; suffix: Hex } {
  const bytes = hexToBytes(data);
  if (bytes.length < 18) return { found: false };

  const tail = bytes.slice(bytes.length - 16);
  const magicBytes = hexToBytes(ERC8021_MAGIC);
  for (let i = 0; i < 16; i++) {
    if (tail[i] !== magicBytes[i]) return { found: false };
  }

  const schemaId = bytes[bytes.length - 17]!;

  if (schemaId === 2) {
    // Delegate Schema 2 (CBOR) decoding to ox — the EIP reference impl.
    // `fromData` returns undefined for malformed envelopes; we surface
    // that as `found: false` since the caller can't act on garbage.
    const decoded = Attribution.fromData(data);
    if (!decoded || decoded.id !== 2) return { found: false };
    // Strip the discriminator before returning to match our typed shape.
    const { id: _id, ...attribution } = decoded;
    // Reconstruct just the suffix bytes for round-trip parity with
    // Schema 0 callers. Re-encode via ox so we get the canonical form.
    const suffix = encodeSchema2Suffix(attribution as Schema2Attribution);
    return { found: true, schemaId: 2, attribution: attribution as Schema2Attribution, suffix };
  }

  // Schema 0 (canonical registry) — inline byte parser.
  const codesLen = bytes[bytes.length - 18]!;
  const start = bytes.length - 18 - codesLen;
  if (start < 4) return { found: false };

  const codesAscii = new TextDecoder().decode(bytes.slice(start, start + codesLen));
  const codes = codesAscii.length === 0 ? [] : codesAscii.split(',');
  const suffix = bytesToHex(bytes.slice(start));

  return { found: true, schemaId: 0, codes, suffix };
}
