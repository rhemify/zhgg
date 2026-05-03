/// Parser tests for the Slice I `delegate <to> <permissionId>` intent.
///
/// The dispatcher lives in src/index.ts (`dispatchDelegate`) and requires
/// real Base Sepolia + 0G Galileo clients to test end-to-end against the
/// deployed DelegationManager — out of scope for a unit test (and per
/// the "no fake" rule in CLAUDE.md, we don't mock the chain).
///
/// What we DO verify here is parser-only contract:
///   - well-formed shapes parse to `kind: 'delegate'` with `<to>` kept
///     verbatim and `permissionId` typed as `0x${string}`;
///   - malformed shapes return `unknown` with a precise reason so the
///     TUI can surface a hint without dispatching.
///
/// Resolution of `<to>` (0x address vs agent role name vs mainnet *.eth)
/// is a dispatcher concern — the parser preserves the user's literal so
/// the audit row can echo it without normalising.

import { describe, it, expect } from 'bun:test';
import { parseIntent } from '../src/intent-parser.js';

describe('delegate — happy path', () => {
  // Typed as `0x${string}` so `expect(...).toBe(PERM)` matches the
  // parser's `permissionId: 0x${string}` field without an `as` cast at
  // every call site.
  const PERM = ('0x' + '0'.repeat(63) + '1') as `0x${string}`;

  it('accepts a 0x address as <to>', () => {
    const r = parseIntent(
      `delegate 0x557E1E07652B75ABaA667223B11704165fC94d09 ${PERM}`,
    );
    expect(r.kind).toBe('delegate');
    if (r.kind !== 'delegate') return;
    expect(r.to).toBe('0x557E1E07652B75ABaA667223B11704165fC94d09');
    expect(r.permissionId).toBe(PERM);
  });

  it('accepts a mainnet ENS name as <to>', () => {
    const r = parseIntent(`delegate vitalik.eth ${PERM}`);
    expect(r.kind).toBe('delegate');
    if (r.kind !== 'delegate') return;
    expect(r.to).toBe('vitalik.eth');
    expect(r.permissionId).toBe(PERM);
  });

  it('accepts an agent role name as <to> (parser keeps verbatim)', () => {
    // Parser does NOT cross-chain resolve — that's the dispatcher's job
    // (AgentNFT.ownerOf on 0G Galileo). The parser preserves the user's
    // literal so the audit row can echo it.
    const r = parseIntent(`delegate oracle ${PERM}`);
    expect(r.kind).toBe('delegate');
    if (r.kind !== 'delegate') return;
    expect(r.to).toBe('oracle');
  });

  it('accepts legacy oracle.zhgg.eth form (backward compat)', () => {
    const r = parseIntent(`delegate oracle.zhgg.eth ${PERM}`);
    expect(r.kind).toBe('delegate');
    if (r.kind !== 'delegate') return;
    expect(r.to).toBe('oracle.zhgg.eth');
  });
});

describe('delegate — malformed', () => {
  const PERM = ('0x' + '0'.repeat(63) + '1') as `0x${string}`;

  it('rejects when <to> is missing', () => {
    const r = parseIntent('delegate');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/delegate needs/);
  });

  it('rejects when <permissionId> is missing', () => {
    const r = parseIntent('delegate vitalik.eth');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/permissionId/);
  });

  it('rejects a malformed permissionId (too short)', () => {
    const r = parseIntent('delegate vitalik.eth 0xdeadbeef');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/permissionId/);
    expect(r.reason).toMatch(/expected 0x \+ 64 hex chars/);
  });

  it('rejects a permissionId missing the 0x prefix', () => {
    const r = parseIntent(
      'delegate vitalik.eth ' + '0'.repeat(63) + '1', // 64 chars but no 0x
    );
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/permissionId/);
  });

  it('rejects a permissionId with non-hex characters', () => {
    const r = parseIntent('delegate vitalik.eth 0x' + 'g'.repeat(64));
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/permissionId/);
  });

  it('rejects when <to> is neither 0x address nor *.eth', () => {
    const r = parseIntent(`delegate notalegalname ${PERM}`);
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/expected 0x-address, agent role name/);
  });

  it('rejects extra arguments past <to> <permissionId>', () => {
    const r = parseIntent(`delegate vitalik.eth ${PERM} extra-arg`);
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/exactly two arguments/);
  });
});
