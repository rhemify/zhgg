import { describe, it, expect } from 'bun:test';
import {
  SPOKE_POOL,
  SPOKE_POOL_ABI,
  caip2ToChainId,
  spokePoolFor,
} from '../src/across.js';

describe('caip2ToChainId', () => {
  it('parses valid CAIP-2 strings', () => {
    expect(caip2ToChainId('eip155:84532')).toBe(84532);
    expect(caip2ToChainId('eip155:1')).toBe(1);
    expect(caip2ToChainId('eip155:421614')).toBe(421614);
  });

  it('returns null for malformed input', () => {
    expect(caip2ToChainId('eip155')).toBeNull();
    expect(caip2ToChainId('eip155:abc')).toBeNull();
    expect(caip2ToChainId('solana:mainnet')).toBeNull();
    expect(caip2ToChainId('')).toBeNull();
  });
});

describe('SPOKE_POOL', () => {
  it('has Base Sepolia spoke pool at the documented address', () => {
    // This is the real address from docs.across.to/reference/contract-addresses
    expect(SPOKE_POOL['eip155:84532']).toBe('0x82B564983aE7274c86695917BBf8C99ECb6F0F8F');
  });

  it('has Arbitrum Sepolia spoke pool', () => {
    expect(SPOKE_POOL['eip155:421614']).toBeDefined();
  });

  it('covers all major mainnet chains', () => {
    expect(SPOKE_POOL['eip155:1']).toBeDefined(); // Ethereum
    expect(SPOKE_POOL['eip155:8453']).toBeDefined(); // Base
    expect(SPOKE_POOL['eip155:42161']).toBeDefined(); // Arbitrum
    expect(SPOKE_POOL['eip155:10']).toBeDefined(); // Optimism
  });
});

describe('spokePoolFor', () => {
  it('returns address for known chains', () => {
    expect(spokePoolFor('eip155:84532')).toBe('0x82B564983aE7274c86695917BBf8C99ECb6F0F8F');
  });

  it('returns null for unknown chains', () => {
    expect(spokePoolFor('eip155:99999')).toBeNull();
    expect(spokePoolFor('garbage')).toBeNull();
  });
});

describe('SPOKE_POOL_ABI', () => {
  it('parses correctly with depositV3 + V3FundsDeposited + FilledV3Relay', () => {
    expect(SPOKE_POOL_ABI.length).toBe(3);
    const fnNames = SPOKE_POOL_ABI.filter((f) => f.type === 'function').map(
      (f) => (f as { name: string }).name
    );
    expect(fnNames).toContain('depositV3');
    const eventNames = SPOKE_POOL_ABI.filter((f) => f.type === 'event').map(
      (f) => (f as { name: string }).name
    );
    expect(eventNames).toContain('V3FundsDeposited');
    expect(eventNames).toContain('FilledV3Relay');
  });
});
