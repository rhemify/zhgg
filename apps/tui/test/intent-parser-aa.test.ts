/// Parser tests for the `aa <owner> [salt]` intent — predict + deploy
/// an ERC-4337 SimpleAccount via AgentSimpleAccountFactory. The
/// dispatcher in src/index.ts requires live RPC clients (predict +
/// createAccount on Base Sepolia) and is out of scope here. What we
/// verify is that every well-formed shape parses to a typed payload
/// and every malformed shape returns `unknown` with a precise hint.

import { describe, it, expect } from 'bun:test';
import { parseIntent } from '../src/intent-parser.js';

const ZERO_SALT = `0x${'0'.repeat(64)}` as const;

describe('aa <owner> — happy path', () => {
  it('lower-case 0x address with no salt defaults to bytes32(0)', () => {
    const r = parseIntent('aa 0x21db000000000000000000000000000000001a92');
    expect(r.kind).toBe('aa-deploy');
    if (r.kind !== 'aa-deploy') return;
    expect(r.owner.toLowerCase()).toBe('0x21db000000000000000000000000000000001a92');
    expect(r.salt).toBe(ZERO_SALT);
  });

  it('mixed-case (EIP-55) address preserved verbatim', () => {
    const r = parseIntent('aa 0x21Db000000000000000000000000000000001A92');
    expect(r.kind).toBe('aa-deploy');
    if (r.kind !== 'aa-deploy') return;
    expect(r.owner).toBe('0x21Db000000000000000000000000000000001A92');
  });

  it('explicit salt accepted as bytes32', () => {
    const salt = '0xdead000000000000000000000000000000000000000000000000000000001234';
    const r = parseIntent(`aa 0x21db000000000000000000000000000000001a92 ${salt}`);
    expect(r.kind).toBe('aa-deploy');
    if (r.kind !== 'aa-deploy') return;
    expect(r.salt).toBe(salt);
  });
});

describe('aa <owner> — malformed', () => {
  it('missing owner returns unknown with usage hint', () => {
    const r = parseIntent('aa');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/owner/i);
  });

  it('non-hex owner refused', () => {
    const r = parseIntent('aa not-an-address');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/owner/i);
  });

  it('owner with wrong length refused', () => {
    const r = parseIntent('aa 0x123');
    expect(r.kind).toBe('unknown');
  });

  it('salt with wrong length refused', () => {
    const r = parseIntent('aa 0x21db000000000000000000000000000000001a92 0xdead');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') return;
    expect(r.reason).toMatch(/salt/i);
  });

  it('extra trailing args refused', () => {
    const r = parseIntent(
      `aa 0x21db000000000000000000000000000000001a92 ${ZERO_SALT} extra`
    );
    expect(r.kind).toBe('unknown');
  });
});
