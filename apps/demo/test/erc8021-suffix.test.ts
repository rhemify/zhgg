import { describe, it, expect } from 'bun:test';
import { encodeFunctionData, keccak256, parseAbi } from 'viem';
import {
  ERC8021_MAGIC,
  appendSuffix,
  detectSuffix,
  encodeSchema0Suffix,
  withErc8021,
} from '../src/erc8021-suffix.js';

const SPLITTER_ABI = parseAbi([
  'function splitERC20Erc8021(address asset, uint256 totalAmount, address agentOwner)',
]);

describe('encodeSchema0Suffix', () => {
  it('produces a suffix that ends with MAGIC', () => {
    const suffix = encodeSchema0Suffix(['zhgg']);
    expect(suffix.endsWith(ERC8021_MAGIC.slice(2))).toBe(true);
  });

  it('rejects empty codes', () => {
    expect(() => encodeSchema0Suffix([])).toThrow();
  });

  it('rejects codes containing comma', () => {
    expect(() => encodeSchema0Suffix(['a,b'])).toThrow();
  });

  it('rejects non-ASCII codes', () => {
    expect(() => encodeSchema0Suffix(['hëllo'])).toThrow();
  });

  it('encodes multi-code as comma-joined ASCII', () => {
    const suffix = encodeSchema0Suffix(['zhgg', 'baseapp']);
    // Pre-pad with a fake 4-byte selector so detect() clears the >=4 byte check.
    const data = ('0xdeadbeef' + suffix.slice(2)) as `0x${string}`;
    const det = detectSuffix(data);
    expect(det.found).toBe(true);
    if (det.found) {
      expect(det.codes).toEqual(['zhgg', 'baseapp']);
      expect(det.schemaId).toBe(0);
    }
  });
});

describe('detectSuffix', () => {
  it('returns found:false for short data', () => {
    expect(detectSuffix('0x1234')).toEqual({ found: false });
  });

  it('returns found:false when magic is wrong', () => {
    const bogus = '0x' + 'aa'.repeat(40);
    expect(detectSuffix(bogus as `0x${string}`)).toEqual({ found: false });
  });

  it('round-trips an encodeFunctionData + suffix payload', () => {
    const inner = encodeFunctionData({
      abi: SPLITTER_ABI,
      functionName: 'splitERC20Erc8021',
      args: [
        '0x0000000000000000000000000000000000000001',
        100_000_000n,
        '0x0000000000000000000000000000000000000002',
      ],
    });
    const tagged = withErc8021(inner, ['zhgg']);
    const det = detectSuffix(tagged);
    expect(det.found).toBe(true);
    if (det.found) {
      expect(det.codes).toEqual(['zhgg']);
      expect(det.schemaId).toBe(0);
    }
  });
});

/// SOL↔TS parity: the bytes the TS encoder produces and the keccak of
/// those bytes must match the same fixture asserted in
/// `contracts/test/FeeSplitter.t.sol::test_erc8021_suffixTag_ts_parity_fixture`.
describe('encodeSchema0Suffix — SOL↔TS parity', () => {
  it('produces the same raw suffix bytes as the on-chain library', () => {
    const expectedSuffix =
      '0x7a6867672c626173656170700c0080218021802180218021802180218021';
    expect(encodeSchema0Suffix(['zhgg', 'baseapp'])).toBe(expectedSuffix);
  });

  it('hashes to the on-chain suffixTag fixture', () => {
    const expectedTag =
      '0x93f18506612d8338d72a3ca6bef0482ea7f37bcddb5c4e4fb708cd0d99da7504';
    expect(keccak256(encodeSchema0Suffix(['zhgg', 'baseapp']))).toBe(expectedTag);
  });
});

describe('appendSuffix + withErc8021', () => {
  it('appends without modifying the original calldata', () => {
    const inner = '0xdeadbeefcafe' as `0x${string}`;
    const suffix = encodeSchema0Suffix(['x']);
    const out = appendSuffix(inner, suffix);
    expect(out.startsWith(inner)).toBe(true);
    expect(out.length).toBe(inner.length + suffix.length - 2); // -2 for the duplicate 0x
  });
});
