/// Parser-level tests for the AxiomCommit intents (Slice H).
///
/// We exercise three contracts:
///   1. `commit <tokenId> <plan>` parses to `axiom-commit` with the
///      tokenId pulled through verbatim and the plan kept as a single
///      whitespace-collapsed string (the dispatcher hashes it).
///   2. `reveal <commitId> <plan>` parses to `axiom-reveal` when the
///      commitId has the canonical 0x + 64-hex shape.
///   3. A malformed commitId (anything other than 0x + 64 hex chars)
///      yields `unknown` with a precise reason — the dispatcher must
///      never see a syntactically invalid id (the on-chain
///      CommitNotFound revert path is reserved for "no such commit",
///      not "the user typed garbage").

import { describe, it, expect } from 'bun:test';
import { parseIntent } from '../src/intent-parser.js';

describe('intent-parser — axiom-commit', () => {
  it('parses `commit 1 buy ETH` into axiom-commit with tokenId=1n', () => {
    const r = parseIntent('commit 1 buy ETH');
    expect(r.kind).toBe('axiom-commit');
    if (r.kind !== 'axiom-commit') throw new Error('discriminant');
    expect(r.tokenId).toBe(1n);
    expect(r.target).toBe('1');
    expect(r.plan).toBe('buy ETH');
  });

  it('keeps multi-word plans as a single space-joined string', () => {
    const r = parseIntent('commit 7 refuse: spend cap exceeded for tokenId 7');
    expect(r.kind).toBe('axiom-commit');
    if (r.kind !== 'axiom-commit') throw new Error('discriminant');
    expect(r.tokenId).toBe(7n);
    expect(r.plan).toBe('refuse: spend cap exceeded for tokenId 7');
  });

  it('rejects `commit 1` (empty plan body)', () => {
    const r = parseIntent('commit 1');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') throw new Error('discriminant');
    expect(r.reason).toMatch(/plan body is empty/);
  });

  it('rejects `commit` (no target)', () => {
    const r = parseIntent('commit');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') throw new Error('discriminant');
    expect(r.reason).toMatch(/needs <tokenId\|ens>/);
  });
});

describe('intent-parser — axiom-reveal', () => {
  // 0x + 64 hex = 32-byte commit handle returned by AxiomCommit.commitPlan.
  const VALID_ID =
    '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

  it('parses `reveal 0x… buy ETH` correctly', () => {
    const r = parseIntent(`reveal ${VALID_ID} buy ETH`);
    expect(r.kind).toBe('axiom-reveal');
    if (r.kind !== 'axiom-reveal') throw new Error('discriminant');
    expect(r.commitId).toBe(VALID_ID);
    expect(r.plan).toBe('buy ETH');
  });

  it('rejects a too-short commitId (not 0x + 64 hex)', () => {
    const r = parseIntent('reveal 0x1234 buy ETH');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') throw new Error('discriminant');
    expect(r.reason).toMatch(/expected 0x \+ 64 hex chars/);
  });

  it('rejects a commitId without the 0x prefix', () => {
    const r = parseIntent(
      'reveal 1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef buy ETH',
    );
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') throw new Error('discriminant');
    expect(r.reason).toMatch(/expected 0x \+ 64 hex chars/);
  });

  it('rejects a commitId with non-hex characters', () => {
    const r = parseIntent(
      `reveal 0xZZZZ567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef buy ETH`,
    );
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') throw new Error('discriminant');
    expect(r.reason).toMatch(/expected 0x \+ 64 hex chars/);
  });

  it('rejects `reveal 0x… ` (empty plan body)', () => {
    const r = parseIntent(`reveal ${VALID_ID}`);
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') throw new Error('discriminant');
    expect(r.reason).toMatch(/plan body is empty/);
  });
});
