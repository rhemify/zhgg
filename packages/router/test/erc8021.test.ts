import { describe, it, expect } from 'bun:test';
import {
  appendFee,
  parseFee,
  detectFee,
  computeFeeAmount,
} from '../src/erc8021.js';
import { ZHGG_ERC8021_MARKER, ZERO_ADDRESS } from '../src/constants.js';

const RECIPIENT_A = '0x1111111111111111111111111111111111111111';
const RECIPIENT_B = '0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd';

describe('erc8021.appendFee', () => {
  it('appends 48 hex chars to simple calldata and 0x-prefixes', () => {
    const out = appendFee('deadbeef', { recipient: RECIPIENT_A, bps: 30 });
    expect(out.startsWith('0x')).toBe(true);
    // raw "deadbeef" is 8 hex chars; suffix is 48 hex chars; "0x" is 2.
    expect(out.length).toBe(2 + 8 + 48);
  });

  it('honors recipient + bps overrides', () => {
    const out = appendFee('00', { recipient: RECIPIENT_A, bps: 250 });
    const suffix = out.slice(out.length - 48);
    expect(suffix.slice(0, 4)).toBe(ZHGG_ERC8021_MARKER);
    expect(`0x${suffix.slice(4, 44)}`).toBe(RECIPIENT_A.toLowerCase());
    expect(parseInt(suffix.slice(44), 16)).toBe(250);
  });

  it('strips 0x prefix on input and re-prefixes the output', () => {
    const a = appendFee('0xdeadbeef', { recipient: RECIPIENT_A, bps: 30 });
    const b = appendFee('deadbeef', { recipient: RECIPIENT_A, bps: 30 });
    expect(a).toBe(b);
    expect(a.startsWith('0x')).toBe(true);
  });

  it('throws on odd-length hex', () => {
    expect(() =>
      appendFee('abc', { recipient: RECIPIENT_A, bps: 30 }),
    ).toThrow('erc8021: invalid calldata hex');
  });

  it('throws on non-hex characters', () => {
    expect(() =>
      appendFee('0xZZ', { recipient: RECIPIENT_A, bps: 30 }),
    ).toThrow('erc8021: invalid calldata hex');
  });

  it('throws on bad recipient (wrong length)', () => {
    expect(() =>
      appendFee('deadbeef', { recipient: '0x1234', bps: 30 }),
    ).toThrow('erc8021: invalid fee recipient address');
  });

  it('throws on bps > 10_000', () => {
    expect(() =>
      appendFee('deadbeef', { recipient: RECIPIENT_A, bps: 10_001 }),
    ).toThrow();
  });

  it('throws on negative bps', () => {
    expect(() =>
      appendFee('deadbeef', { recipient: RECIPIENT_A, bps: -1 }),
    ).toThrow();
  });

  it('produces a suffix even with bps=0 (zero-fee protocol tag)', () => {
    const out = appendFee('deadbeef', { recipient: ZERO_ADDRESS, bps: 0 });
    expect(out.length).toBe(2 + 8 + 48);
    const suffix = out.slice(out.length - 48);
    expect(suffix.slice(0, 4)).toBe(ZHGG_ERC8021_MARKER);
    expect(parseInt(suffix.slice(44), 16)).toBe(0);
  });

  it('lowercases recipient hex in the suffix', () => {
    const out = appendFee('deadbeef', { recipient: RECIPIENT_B, bps: 100 });
    const suffix = out.slice(out.length - 48);
    expect(`0x${suffix.slice(4, 44)}`).toBe(RECIPIENT_B.toLowerCase());
  });

  it('encodes bps big-endian (uint16)', () => {
    // 0x0102 = 258 — high byte 0x01, low byte 0x02 — must appear as "0102"
    const out = appendFee('00', { recipient: RECIPIENT_A, bps: 258 });
    expect(out.slice(out.length - 4)).toBe('0102');
  });
});

describe('erc8021.parseFee', () => {
  it('round-trips appendFee output to matching FeeSuffix', () => {
    const tagged = appendFee('deadbeef', {
      recipient: RECIPIENT_A,
      bps: 30,
    });
    const result = parseFee(tagged);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.suffix.marker).toBe(ZHGG_ERC8021_MARKER);
    expect(result.suffix.recipient).toBe(RECIPIENT_A.toLowerCase());
    expect(result.suffix.bps).toBe(30);
  });

  it('returns null on calldata without suffix (no marker)', () => {
    // 48+ hex chars but the marker bytes don't match.
    const noMarker = `0x${'00'.repeat(40)}`;
    expect(parseFee(noMarker)).toBeNull();
  });

  it('returns null on too-short calldata', () => {
    expect(parseFee('0xdead')).toBeNull();
    expect(parseFee('0x')).toBeNull();
    expect(parseFee('')).toBeNull();
  });

  it('returns null on calldata with wrong marker', () => {
    // 48 hex chars where the leading 4 are NOT 8021.
    const bad = `0x${'ff'.repeat(2)}${'11'.repeat(20)}${'001e'}`;
    expect(parseFee(bad)).toBeNull();
  });

  it('returns null on non-hex tail (defensive, no throw)', () => {
    expect(parseFee('0xZZZZZZZZZZZZZZZZ')).toBeNull();
  });

  it('round-trip: parseFee(appendFee(x)).stripped === "0x" + x lowercased', () => {
    const original = 'DeAdBeEfCa11';
    const tagged = appendFee(original, {
      recipient: RECIPIENT_A,
      bps: 30,
    });
    const result = parseFee(tagged);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.stripped).toBe(`0x${original.toLowerCase()}`);
  });
});

describe('erc8021.detectFee', () => {
  it('returns the same suffix as parseFee.suffix', () => {
    const tagged = appendFee('deadbeef', {
      recipient: RECIPIENT_A,
      bps: 30,
    });
    const parsed = parseFee(tagged);
    const detected = detectFee(tagged);
    expect(detected).toEqual(parsed?.suffix ?? null);
  });

  it('returns null when no suffix present', () => {
    expect(detectFee('0xdead')).toBeNull();
  });
});

describe('erc8021.computeFeeAmount', () => {
  it('returns 30 bps of 1_000_000 = 3000', () => {
    expect(computeFeeAmount(1_000_000n, 30)).toBe(3000n);
  });

  it('returns 0 for amount=0', () => {
    expect(computeFeeAmount(0n, 30)).toBe(0n);
    expect(computeFeeAmount(0n, 10_000)).toBe(0n);
  });

  it('returns 0 for bps=0 regardless of amount', () => {
    expect(computeFeeAmount(123_456_789n, 0)).toBe(0n);
  });

  it('floors integer division', () => {
    // 1n * 30 / 10_000 = 0 (integer)
    expect(computeFeeAmount(1n, 30)).toBe(0n);
  });
});
