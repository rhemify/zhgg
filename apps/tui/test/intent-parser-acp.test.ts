/// Parser tests for the Slice J `acp create` / `acp release` intents.
///
/// The dispatchers live in src/acp-intents.ts and require live RPC clients
/// to test end-to-end against AgenticCommerce on 0G — out of scope for a
/// unit test. What we DO verify here is that every well-formed shape
/// parses to the right `kind` + payload, and every malformed shape
/// returns `unknown` with a precise reason. Parser is sync + pure, so
/// these are deterministic without any environment.

import { describe, it, expect } from 'bun:test';
import { parseIntent } from '../src/intent-parser.js';

describe('acp create — happy path', () => {
  it('digit tokenId + integer USDC amount', () => {
    const r = parseIntent('acp create 2 10');
    expect(r.kind).toBe('acp-create');
    if (r.kind !== 'acp-create') return;
    expect(r.target).toBe('2');
    expect(r.tokenId).toBe(2n);
    expect(r.usdcAmount).toBe('10');
  });

  it('digit tokenId + decimal USDC amount', () => {
    const r = parseIntent('acp create 1 0.5');
    expect(r.kind).toBe('acp-create');
    if (r.kind !== 'acp-create') return;
    expect(r.tokenId).toBe(1n);
    expect(r.usdcAmount).toBe('0.5');
  });

  it('role name resolves via agent-registry', () => {
    const r = parseIntent('acp create oracle 1.25');
    expect(r.kind).toBe('acp-create');
    if (r.kind !== 'acp-create') return;
    expect(r.target).toBe('oracle');
    expect(r.tokenId).toBe(2n);
    expect(r.usdcAmount).toBe('1.25');
  });

  it('legacy .zhgg.eth suffix still resolves (backward compat)', () => {
    const r = parseIntent('acp create oracle.zhgg.eth 1.25');
    expect(r.kind).toBe('acp-create');
    if (r.kind !== 'acp-create') return;
    expect(r.tokenId).toBe(2n);
  });

  it('case-insensitive role label', () => {
    const r = parseIntent('acp create AUDIT 100');
    expect(r.kind).toBe('acp-create');
    if (r.kind !== 'acp-create') return;
    expect(r.tokenId).toBe(1n);
  });

  it('large amount with many decimals', () => {
    const r = parseIntent('acp create 3 1234567.123456');
    expect(r.kind).toBe('acp-create');
    if (r.kind !== 'acp-create') return;
    expect(r.usdcAmount).toBe('1234567.123456');
  });
});

describe('acp create — malformed', () => {
  it('missing both args returns unknown with usage hint', () => {
    const r = parseIntent('acp create');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/agentTokenId/);
    expect(r.reason).toMatch(/usdcAmount/);
  });

  it('missing amount returns unknown', () => {
    const r = parseIntent('acp create 1');
    expect(r.kind).toBe('unknown');
  });

  it('extra arg returns unknown', () => {
    const r = parseIntent('acp create 1 10 extra');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/exactly two arguments/);
  });

  it('non-decimal amount returns unknown with the raw value', () => {
    const r = parseIntent('acp create 1 ten');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/"ten"/);
    expect(r.reason).toMatch(/decimal/);
  });

  it('negative amount returns unknown (the regex anchors digits)', () => {
    const r = parseIntent('acp create 1 -5');
    expect(r.kind).toBe('unknown');
  });

  it('zero amount is rejected with ZeroBudget hint', () => {
    const r = parseIntent('acp create 1 0');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/escrow must be > 0/);
    expect(r.reason).toMatch(/ZeroBudget/);
  });

  it('zero with decimals is rejected too', () => {
    const r = parseIntent('acp create 1 0.00');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/ZeroBudget/);
  });

  it('non-numeric token target falls through to generic unknown', () => {
    const r = parseIntent('acp create not-a-token 10');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/expected an agent role name.*or numeric tokenId/);
  });

  it('ENS not in registry returns unknown_agent', () => {
    const r = parseIntent('acp create ghost.zhgg.eth 1');
    expect(r.kind).toBe('unknown_agent');
    if (r.kind !== 'unknown_agent') return;
    expect(r.target).toBe('ghost.zhgg.eth');
    expect(r.message).toMatch(/not in agent-registry/);
  });
});

describe('acp release — happy path', () => {
  it('jobId 1', () => {
    const r = parseIntent('acp release 1');
    expect(r.kind).toBe('acp-release');
    if (r.kind !== 'acp-release') return;
    expect(r.jobId).toBe(1n);
  });

  it('large jobId', () => {
    const r = parseIntent('acp release 999999999999999');
    expect(r.kind).toBe('acp-release');
    if (r.kind !== 'acp-release') return;
    expect(r.jobId).toBe(999999999999999n);
  });
});

describe('acp release — malformed', () => {
  it('missing jobId returns unknown', () => {
    const r = parseIntent('acp release');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/jobId/);
  });

  it('extra arg returns unknown', () => {
    const r = parseIntent('acp release 1 extra');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/exactly one argument/);
  });

  it('non-numeric jobId returns unknown', () => {
    const r = parseIntent('acp release abc');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/uint256 digits/);
  });

  it('hex jobId returns unknown (digits only)', () => {
    const r = parseIntent('acp release 0x1');
    expect(r.kind).toBe('unknown');
  });

  it('zero jobId returns unknown (counter starts at 1)', () => {
    const r = parseIntent('acp release 0');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/jobIds start at 1/);
  });

  it('decimal jobId returns unknown', () => {
    const r = parseIntent('acp release 1.5');
    expect(r.kind).toBe('unknown');
  });
});

describe('acp — sub-verb errors', () => {
  it('bare `acp` returns unknown with sub-verb list', () => {
    const r = parseIntent('acp');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/create.*release/);
  });

  it('unknown sub-verb returns unknown with reason', () => {
    const r = parseIntent('acp swap 1 10');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/unknown sub-verb/);
    expect(r.reason).toMatch(/create, release/);
  });
});
