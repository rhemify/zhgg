/// Intel TDX quote parser — Phase 23.
///
/// Parses a TDX quote envelope per the Intel SGX/TDX Quoting Library
/// data structures spec (rev 5.x). Quote layout v4 (TDX):
///
///   [ Header        48 bytes ]   version + key type + tee type + qe svn ...
///   [ TD Report   584 bytes ]   tee_tcb_svn(16) + mr_seam(48) + ... + report_data(64)
///   [ Sig Data Len  4 bytes ]
///   [ Sig Data      N bytes ]   ECDSA p256 sig + attestation key + cert chain
///
/// We extract the structural fields needed for verification without
/// pulling a heavy SGX SDK. Real quote-validity checks require the
/// Intel root CA cert — that's wired in `verifier.ts`.
///
/// Reference: Intel SGX DCAP Library data-structures spec
///   https://download.01.org/intel-sgx/sgx-dcap/

import { hexToBytes, type Hex } from 'viem';

export interface ParsedQuote {
  version: number;
  /// 0 = ECDSA-256-with-P-256 + AES-128-CMAC. Spec ID 2 for TDX.
  attestationKeyType: number;
  /// 0x81 = TDX. 0x00 = SGX.
  teeType: number;
  qeSvn: number;
  pceSvn: number;
  /// 16-byte vendor identifier — `939A7233F79C4CA9940A0DB3957F0607` for Intel.
  qeVendorId: Hex;
  userData: Hex;

  // TD Report body (TDX-specific)
  teeTcbSvn: Hex;
  mrSeam: Hex;        // SEAM module measurement
  mrTd: Hex;          // TD measurement (deterministic TDX VM hash)
  /// 64 bytes of arbitrary user-provided data — typically a binding to
  /// an off-chain payload (e.g. signature over a chat completion).
  reportData: Hex;

  /// Bytes 0..N of the signature data section. ECDSA-P256 signature +
  /// attestation key + cert chain — used by `verifyQuoteSignature`.
  signatureData: Hex;

  /// Total parsed length — useful for sanity-checking the input.
  totalBytes: number;
}

export type ParseError =
  | { kind: 'too_short'; need: number; got: number }
  | { kind: 'unsupported_version'; version: number }
  | { kind: 'unsupported_tee'; teeType: number }
  | { kind: 'unsupported_attestation_key'; type: number };

export type ParseOutcome =
  | { ok: true; value: ParsedQuote }
  | { ok: false; error: ParseError };

/// Minimum bytes for a valid TDX v4 quote: 48 header + 584 td report +
/// 4 sig-data-length prefix.
const MIN_QUOTE_BYTES = 48 + 584 + 4;

/// Header offsets (bytes).
const HDR_VERSION_OFFSET           = 0;   // uint16
const HDR_ATTESTATION_KEY_OFFSET   = 2;   // uint16
const HDR_TEE_TYPE_OFFSET          = 4;   // uint32
const HDR_QE_SVN_OFFSET            = 8;   // uint16
const HDR_PCE_SVN_OFFSET           = 10;  // uint16
const HDR_QE_VENDOR_OFFSET         = 12;  // 16 bytes
const HDR_USER_DATA_OFFSET         = 28;  // 20 bytes
const HEADER_SIZE                  = 48;

/// TD Report offsets (within the 584-byte body, relative to body start).
const TDR_TEE_TCB_SVN_OFFSET       = 0;    // 16 bytes
const TDR_MR_SEAM_OFFSET           = 16;   // 48 bytes
const TDR_MR_TD_OFFSET             = 184;  // 48 bytes
const TDR_REPORT_DATA_OFFSET       = 520;  // 64 bytes
const TD_REPORT_SIZE               = 584;

export function parseQuote(quoteHex: Hex): ParseOutcome {
  const bytes = hexToBytes(quoteHex);
  if (bytes.length < MIN_QUOTE_BYTES) {
    return { ok: false, error: { kind: 'too_short', need: MIN_QUOTE_BYTES, got: bytes.length } };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const version = view.getUint16(HDR_VERSION_OFFSET, true);
  if (version !== 4 && version !== 5) {
    return { ok: false, error: { kind: 'unsupported_version', version } };
  }

  const attestationKeyType = view.getUint16(HDR_ATTESTATION_KEY_OFFSET, true);
  if (attestationKeyType !== 2) {
    // ECDSA-256-with-P-256 = 2 for TDX. Type 0/1 are SGX-era.
    return { ok: false, error: { kind: 'unsupported_attestation_key', type: attestationKeyType } };
  }

  const teeType = view.getUint32(HDR_TEE_TYPE_OFFSET, true);
  if (teeType !== 0x81) {
    // 0x81 = TDX, 0x00 = SGX. We only sign off on TDX for 0G Compute.
    return { ok: false, error: { kind: 'unsupported_tee', teeType } };
  }

  const qeSvn = view.getUint16(HDR_QE_SVN_OFFSET, true);
  const pceSvn = view.getUint16(HDR_PCE_SVN_OFFSET, true);
  const qeVendorId = sliceHex(bytes, HDR_QE_VENDOR_OFFSET, 16);
  const userData = sliceHex(bytes, HDR_USER_DATA_OFFSET, 20);

  // TD Report follows the header.
  const tdrStart = HEADER_SIZE;
  const teeTcbSvn = sliceHex(bytes, tdrStart + TDR_TEE_TCB_SVN_OFFSET, 16);
  const mrSeam = sliceHex(bytes, tdrStart + TDR_MR_SEAM_OFFSET, 48);
  const mrTd = sliceHex(bytes, tdrStart + TDR_MR_TD_OFFSET, 48);
  const reportData = sliceHex(bytes, tdrStart + TDR_REPORT_DATA_OFFSET, 64);

  // Signature data length follows the TD Report.
  const sigLenOffset = HEADER_SIZE + TD_REPORT_SIZE;
  const sigDataLen = view.getUint32(sigLenOffset, true);
  if (bytes.length < sigLenOffset + 4 + sigDataLen) {
    return {
      ok: false,
      error: {
        kind: 'too_short',
        need: sigLenOffset + 4 + sigDataLen,
        got: bytes.length,
      },
    };
  }
  const signatureData = sliceHex(bytes, sigLenOffset + 4, sigDataLen);

  return {
    ok: true,
    value: {
      version,
      attestationKeyType,
      teeType,
      qeSvn,
      pceSvn,
      qeVendorId,
      userData,
      teeTcbSvn,
      mrSeam,
      mrTd,
      reportData,
      signatureData,
      totalBytes: sigLenOffset + 4 + sigDataLen,
    },
  };
}

function sliceHex(bytes: Uint8Array, offset: number, length: number): Hex {
  const slice = bytes.slice(offset, offset + length);
  return ('0x' + Buffer.from(slice).toString('hex')) as Hex;
}

/// Intel's published QE Vendor ID — every legitimate Intel-signed TDX
/// quote has this byte sequence in the QE vendor field. Mismatch =
/// quote came from a non-Intel quoting enclave (red flag).
export const INTEL_QE_VENDOR_ID: Hex = '0x939a7233f79c4ca9940a0db3957f0607';
