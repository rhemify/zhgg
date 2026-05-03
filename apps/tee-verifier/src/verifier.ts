/// TEE attestation verifier — Phase 23.
///
/// Validates a TDX quote envelope from 0G Compute Router by:
///   1. Parsing the quote structure (header + TD report + sig data)
///   2. Checking the QE vendor ID is Intel's published value
///   3. Cross-checking the `signing_address` claim against `report_data`
///      (the TEE binds its ECDSA key to the report by hashing it into
///      the 64-byte report_data field)
///   4. Returning a structured verdict the workflow's
///      `verifyTeeAttestation` can consume
///
/// What this CAN'T do without an Intel root CA cert + collateral:
///   - validate the cert chain in `signature_data` against the Intel
///     SGX attestation root CA (CN: "Intel SGX Attestation Report Signing")
///   - validate the TCB info against the Intel PCS / cached collateral
///   - check the SEAM measurement against a curated allowlist of
///     known-good 0G Compute SEAM versions
///
/// All three of those land in `phase23-extras.md` (post-deploy when we
/// have a real 0G TEE quote to test against). For now the verifier
/// performs structural + identity checks that catch malformed or
/// non-Intel quotes; it labels its output `verdict: 'structural'` so
/// downstream code can distinguish from a future full-cert verdict.

import { keccak256, isAddress } from 'viem';
import {
  INTEL_QE_VENDOR_ID,
  parseQuote,
  type ParseOutcome,
  type ParsedQuote,
} from './quote-parser.js';

export type Verdict = 'structural' | 'cert_chain';

export interface VerifyRequest {
  /// Hex-encoded TDX quote (whole envelope including header + TD report
  /// + sig data).
  intel_quote: `0x${string}` | string;
  /// EOA the TEE claims is its signing key. Must equal lower 20 bytes
  /// of `keccak256(report_data)` per 0G Compute's binding.
  signing_address: string;
  /// "ecdsa" — only supported algorithm in v1.
  signing_algo?: string;
  /// Optional nonce the caller supplied to the TEE. We don't bind this
  /// to the quote but log it for audit trails.
  request_nonce?: string;
}

export interface VerifyResponse {
  valid: boolean;
  verdict?: Verdict;
  /// Lower-cased hex address recovered from the TEE binding. When
  /// `valid: true`, equals the request's `signing_address`.
  attestedAddress?: string;
  /// Parsed key fields for off-chain audit logs (mr_td, mr_seam,
  /// tee_tcb_svn). Hex-encoded.
  measurements?: {
    mrTd: string;
    mrSeam: string;
    teeTcbSvn: string;
  };
  reason?: string;
}

/// Run the verifier and return a structured verdict. Pure function —
/// no I/O. Server side wraps this in an HTTP handler.
export function verifyTdxQuote(req: VerifyRequest): VerifyResponse {
  const parsed: ParseOutcome = parseQuote((req.intel_quote.startsWith('0x') ? req.intel_quote : `0x${req.intel_quote}`) as `0x${string}`);
  if (!parsed.ok) {
    return { valid: false, reason: `parse_error: ${parsed.error.kind}` };
  }
  const q: ParsedQuote = parsed.value;

  // 1. QE vendor ID must be Intel's published value.
  if (q.qeVendorId.toLowerCase() !== INTEL_QE_VENDOR_ID.toLowerCase()) {
    return {
      valid: false,
      reason: `qe_vendor_mismatch: got ${q.qeVendorId}, want ${INTEL_QE_VENDOR_ID}`,
    };
  }

  // 2. Signing-address sanity: the request claims a specific address.
  if (!isAddress(req.signing_address)) {
    return { valid: false, reason: `bad_signing_address: ${req.signing_address}` };
  }

  // 3. Bind: 0G Compute writes `keccak256(signing_pubkey)` (or directly
  //    the address for ease) into the first 20 bytes of report_data.
  //    The contract is: lower 20 bytes of report_data ↓ matches the
  //    request's signing_address (lowercased).
  const reportDataBytes = req.signing_address.toLowerCase().slice(2); // drop 0x
  const lower20 = q.reportData.slice(2, 2 + 40).toLowerCase();
  if (lower20 !== reportDataBytes) {
    return {
      valid: false,
      reason: `binding_mismatch: report_data[0..20]=${q.reportData.slice(0, 42)} signing_address=${req.signing_address}`,
    };
  }

  // 4. Optional bind: bytes [32..64] of report_data carry the 32-byte
  //    request_nonce (verified against the LLM-format envelope at
  //    `0g-compute-ts-sdk/llm_attestation_report.json` — bytes [20..32]
  //    are NUL pad, [32..64] is the nonce). Skip when the caller
  //    didn't supply request_nonce (server.ts treats it as optional).
  //    NOTE: this layout is LLM-format only; broker reports use ASCII
  //    binding and SHOULD route through a different verifier path.
  if (req.request_nonce) {
    const expectedNonce = req.request_nonce.toLowerCase().replace(/^0x/, '');
    const reportNonce = q.reportData.slice(2 + 64, 2 + 128).toLowerCase();
    if (reportNonce !== expectedNonce) {
      return {
        valid: false,
        reason: `nonce_mismatch: report_data[32..64]=${reportNonce} request_nonce=${expectedNonce}`,
      };
    }
  }

  return {
    valid: true,
    verdict: 'structural',
    attestedAddress: req.signing_address.toLowerCase(),
    measurements: {
      mrTd: q.mrTd,
      mrSeam: q.mrSeam,
      teeTcbSvn: q.teeTcbSvn,
    },
  };
}

/// Convenience: hash the Intel-format binding and compare. Useful for
/// constructing test fixtures.
export function expectedBinding(signingAddress: string): string {
  return keccak256(signingAddress as `0x${string}`).slice(0, 42);
}
