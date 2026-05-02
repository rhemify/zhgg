/// Parser tests for the Slice K `park` / `unpark` intents.
///
/// The dispatchers live in src/yield-intents.ts and require live RPC
/// clients + a deployed MockERC4626 to test end-to-end against the
/// AgentReceiverWallet on Base Sepolia — out of scope for a unit test.
/// What we DO verify here is that every well-formed shape parses to
/// the right `kind` + payload, and every malformed shape returns
/// `unknown` with a precise reason. Parser is sync + pure, so these
/// are deterministic without any environment.

import { describe, it, expect } from 'bun:test';
import { parseIntent } from '../src/intent-parser.js';

describe('park — happy path (short form, default tokenId=1)', () => {
  it('integer USDC amount', () => {
    const r = parseIntent('park 1 USDC');
    expect(r.kind).toBe('park');
    if (r.kind !== 'park') return;
    expect(r.amount).toBe('1');
    expect(r.symbol).toBe('USDC');
    expect(r.tokenId).toBe(1n);
  });

  it('decimal USDC amount', () => {
    const r = parseIntent('park 0.5 USDC');
    expect(r.kind).toBe('park');
    if (r.kind !== 'park') return;
    expect(r.amount).toBe('0.5');
    expect(r.symbol).toBe('USDC');
    expect(r.tokenId).toBe(1n);
  });

  it('WETH symbol (case-insensitive)', () => {
    const r = parseIntent('park 0.001 weth');
    expect(r.kind).toBe('park');
    if (r.kind !== 'park') return;
    expect(r.symbol).toBe('WETH');
    expect(r.tokenId).toBe(1n);
  });
});

describe('park — happy path (explicit tokenId form)', () => {
  it('tokenId 2 + USDC', () => {
    const r = parseIntent('park 2 0.5 USDC');
    expect(r.kind).toBe('park');
    if (r.kind !== 'park') return;
    expect(r.tokenId).toBe(2n);
    expect(r.amount).toBe('0.5');
    expect(r.symbol).toBe('USDC');
  });

  it('tokenId 3 + WETH', () => {
    const r = parseIntent('park 3 0.01 WETH');
    expect(r.kind).toBe('park');
    if (r.kind !== 'park') return;
    expect(r.tokenId).toBe(3n);
    expect(r.symbol).toBe('WETH');
  });
});

describe('unpark — happy path', () => {
  it('short form defaults to tokenId 1', () => {
    const r = parseIntent('unpark 0.5 USDC');
    expect(r.kind).toBe('unpark');
    if (r.kind !== 'unpark') return;
    expect(r.amount).toBe('0.5');
    expect(r.symbol).toBe('USDC');
    expect(r.tokenId).toBe(1n);
  });

  it('explicit tokenId form', () => {
    const r = parseIntent('unpark 2 1 USDC');
    expect(r.kind).toBe('unpark');
    if (r.kind !== 'unpark') return;
    expect(r.tokenId).toBe(2n);
    expect(r.amount).toBe('1');
  });
});

describe('park — rejected shapes', () => {
  it('rejects native ETH (vault wraps an ERC-20)', () => {
    const r = parseIntent('park 0.001 ETH');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/native ETH not allowed/i);
  });

  it('rejects bare amount with no symbol', () => {
    const r = parseIntent('park 1');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/<amount> <USDC\|WETH>/);
  });

  it('rejects unknown symbol', () => {
    const r = parseIntent('park 1 DAI');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/supported: USDC, WETH/);
  });

  it('rejects non-numeric amount', () => {
    const r = parseIntent('park abc USDC');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/expected decimal/);
  });

  it('rejects non-integer tokenId in explicit form', () => {
    const r = parseIntent('park abc 1 USDC');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/positive integer/);
  });

  it('rejects too many args', () => {
    const r = parseIntent('park 1 2 USDC extra');
    expect(r.kind).toBe('unknown');
  });
});

describe('unpark — rejected shapes', () => {
  it('rejects ETH', () => {
    const r = parseIntent('unpark 0.5 ETH');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/native ETH not allowed/i);
  });

  it('rejects empty', () => {
    const r = parseIntent('unpark');
    expect(r.kind).toBe('unknown');
  });
});
