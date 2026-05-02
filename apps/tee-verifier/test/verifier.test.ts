import { describe, it, expect } from 'bun:test';
import { parseQuote, INTEL_QE_VENDOR_ID } from '../src/quote-parser.js';
import { verifyTdxQuote } from '../src/verifier.js';

/// Build a minimum-viable TDX quote envelope from typed fields. Used to
/// drive the parser + verifier without needing a real Intel-signed
/// quote (we don't have one until 0G Compute hands us one). Every byte
/// that the parser reads is set deterministically so the tests are
/// reproducible.
function buildQuote(args: {
  qeVendor: string;
  signingAddress: string;
  mrTd?: string;
  mrSeam?: string;
  teeTcbSvn?: string;
  version?: number;
  attestationKey?: number;
  teeType?: number;
}): string {
  const u8 = new Uint8Array(48 + 584 + 4 + 100); // 100 bytes of padding sig data
  const view = new DataView(u8.buffer);

  view.setUint16(0, args.version ?? 4, true);
  view.setUint16(2, args.attestationKey ?? 2, true);
  view.setUint32(4, args.teeType ?? 0x81, true);
  view.setUint16(8, 1, true); // qeSvn
  view.setUint16(10, 1, true); // pceSvn

  // QE vendor ID (16 bytes)
  const vendor = hexToBytes(args.qeVendor);
  u8.set(vendor.slice(0, 16), 12);

  // 20 bytes of user data
  u8.set(new Uint8Array(20), 28);

  // TD report (584 bytes) starts at offset 48.
  const tdrStart = 48;
  // tee_tcb_svn (16 bytes)
  if (args.teeTcbSvn) u8.set(hexToBytes(args.teeTcbSvn).slice(0, 16), tdrStart + 0);
  // mr_seam (48 bytes)
  if (args.mrSeam) u8.set(hexToBytes(args.mrSeam).slice(0, 48), tdrStart + 16);
  // mr_td (48 bytes)
  if (args.mrTd) u8.set(hexToBytes(args.mrTd).slice(0, 48), tdrStart + 184);

  // report_data (64 bytes) — first 20 bytes are signing_address.
  const addr = hexToBytes(args.signingAddress);
  u8.set(addr.slice(0, 20), tdrStart + 520);

  // signature data length = 100
  view.setUint32(48 + 584, 100, true);

  return '0x' + Buffer.from(u8).toString('hex');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return out;
}

const TEST_ADDR = '0xcA11E7c00Ffe5c0De0000000000000000000beeF';

describe('parseQuote', () => {
  it('parses a valid TDX v4 quote', () => {
    const q = buildQuote({ qeVendor: INTEL_QE_VENDOR_ID, signingAddress: TEST_ADDR });
    const r = parseQuote(q as `0x${string}`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.version).toBe(4);
      expect(r.value.teeType).toBe(0x81);
      expect(r.value.qeVendorId.toLowerCase()).toBe(INTEL_QE_VENDOR_ID.toLowerCase());
    }
  });

  it('rejects a quote that is too short', () => {
    const r = parseQuote('0xdeadbeef');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('too_short');
  });

  it('rejects an unsupported version', () => {
    const q = buildQuote({ qeVendor: INTEL_QE_VENDOR_ID, signingAddress: TEST_ADDR, version: 9 });
    const r = parseQuote(q as `0x${string}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('unsupported_version');
  });

  it('rejects an unsupported tee type (e.g. SGX)', () => {
    const q = buildQuote({ qeVendor: INTEL_QE_VENDOR_ID, signingAddress: TEST_ADDR, teeType: 0x00 });
    const r = parseQuote(q as `0x${string}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('unsupported_tee');
  });

  it('rejects an unsupported attestation key type', () => {
    const q = buildQuote({
      qeVendor: INTEL_QE_VENDOR_ID,
      signingAddress: TEST_ADDR,
      attestationKey: 99,
    });
    const r = parseQuote(q as `0x${string}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('unsupported_attestation_key');
  });
});

describe('verifyTdxQuote', () => {
  it('accepts a quote whose report_data binds to the signing address', () => {
    const q = buildQuote({ qeVendor: INTEL_QE_VENDOR_ID, signingAddress: TEST_ADDR });
    const r = verifyTdxQuote({
      intel_quote: q,
      signing_address: TEST_ADDR,
    });
    expect(r.valid).toBe(true);
    expect(r.verdict).toBe('structural');
    expect(r.attestedAddress).toBe(TEST_ADDR.toLowerCase());
    expect(r.measurements?.mrTd).toBeDefined();
  });

  it('rejects a quote with non-Intel QE vendor', () => {
    const q = buildQuote({
      qeVendor: '0x' + 'ff'.repeat(16),
      signingAddress: TEST_ADDR,
    });
    const r = verifyTdxQuote({ intel_quote: q, signing_address: TEST_ADDR });
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('qe_vendor_mismatch');
  });

  it('rejects a quote where report_data does NOT match the signing address', () => {
    const q = buildQuote({
      qeVendor: INTEL_QE_VENDOR_ID,
      signingAddress: '0x' + 'aa'.repeat(20), // bound to a different address
    });
    const r = verifyTdxQuote({ intel_quote: q, signing_address: TEST_ADDR });
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('binding_mismatch');
  });

  it('rejects a malformed signing address', () => {
    const q = buildQuote({ qeVendor: INTEL_QE_VENDOR_ID, signingAddress: TEST_ADDR });
    const r = verifyTdxQuote({ intel_quote: q, signing_address: 'not-an-address' });
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('bad_signing_address');
  });

  it('passes mr_td / mr_seam / tee_tcb_svn through to measurements', () => {
    const mrTd = '0x' + '11'.repeat(48);
    const mrSeam = '0x' + '22'.repeat(48);
    const teeTcbSvn = '0x' + '33'.repeat(16);
    const q = buildQuote({
      qeVendor: INTEL_QE_VENDOR_ID,
      signingAddress: TEST_ADDR,
      mrTd,
      mrSeam,
      teeTcbSvn,
    });
    const r = verifyTdxQuote({ intel_quote: q, signing_address: TEST_ADDR });
    expect(r.valid).toBe(true);
    expect(r.measurements?.mrTd.toLowerCase()).toBe(mrTd);
    expect(r.measurements?.mrSeam.toLowerCase()).toBe(mrSeam);
    expect(r.measurements?.teeTcbSvn.toLowerCase()).toBe(teeTcbSvn);
  });
});
