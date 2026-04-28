import { describe, it, expect, beforeEach } from 'bun:test';
import {
  loadEnv,
  resetEnv,
  requireZgKey,
  requireBaseSepoliaKey,
  requireScopeSecret,
  requireAgentNftAddress,
  requireInftTokenId,
  ZG_GALILEO_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  DEFAULT_ZG_RPC_URL,
  DEFAULT_KEEPERHUB_MCP_ENDPOINT,
  ZERO_ADDRESS,
  ZHGG_ERC8021_MARKER,
} from '../src/constants.js';

const VALID_KEY = '0x' + 'a'.repeat(64);
const VALID_ADDRESS = '0x' + 'b'.repeat(40);
const VALID_SECRET = 'a'.repeat(32);

describe('constants', () => {
  it('exposes 0G Galileo chain ID', () => {
    expect(ZG_GALILEO_CHAIN_ID).toBe(16602);
  });

  it('exposes Base Sepolia chain ID', () => {
    expect(BASE_SEPOLIA_CHAIN_ID).toBe(84532);
  });

  it('exposes default 0G RPC URL', () => {
    expect(DEFAULT_ZG_RPC_URL).toBe('https://evmrpc-testnet.0g.ai');
  });

  it('exposes default KeeperHub MCP endpoint', () => {
    expect(DEFAULT_KEEPERHUB_MCP_ENDPOINT).toBe('https://app.keeperhub.com/mcp');
  });

  it('exposes ERC-8021 marker as 4 hex chars', () => {
    expect(ZHGG_ERC8021_MARKER).toMatch(/^[0-9a-fA-F]{4}$/);
  });

  it('exposes zero address constant', () => {
    expect(ZERO_ADDRESS).toBe('0x0000000000000000000000000000000000000000');
  });
});

describe('loadEnv', () => {
  beforeEach(() => resetEnv());

  it('loads with defaults when only required-with-default keys present', () => {
    const env = loadEnv({});
    expect(env.ZG_RPC_URL).toBe(DEFAULT_ZG_RPC_URL);
    expect(env.KEEPERHUB_MCP_ENDPOINT).toBe(DEFAULT_KEEPERHUB_MCP_ENDPOINT);
    expect(env.ZHGG_FEE_BPS).toBe(30);
    expect(env.ZHGG_FEE_RECIPIENT).toBe(ZERO_ADDRESS);
  });

  it('overrides defaults from supplied source', () => {
    const env = loadEnv({ ZHGG_FEE_BPS: '100' });
    expect(env.ZHGG_FEE_BPS).toBe(100);
  });

  it('does not cache custom-source loads', () => {
    const a = loadEnv({ ZHGG_FEE_BPS: '50' });
    const b = loadEnv({ ZHGG_FEE_BPS: '75' });
    expect(a.ZHGG_FEE_BPS).toBe(50);
    expect(b.ZHGG_FEE_BPS).toBe(75);
  });

  it('rejects bad private key format', () => {
    expect(() => loadEnv({ ZG_PRIVATE_KEY: 'not-hex' })).toThrow();
  });

  it('rejects address with wrong length', () => {
    expect(() => loadEnv({ ZHGG_FEE_RECIPIENT: '0xshort' })).toThrow();
  });

  it('rejects non-URL RPC', () => {
    expect(() => loadEnv({ ZG_RPC_URL: 'not-a-url' })).toThrow();
  });

  it('rejects ZHGG_FEE_BPS over 10000', () => {
    expect(() => loadEnv({ ZHGG_FEE_BPS: '99999' })).toThrow();
  });

  it('rejects ZHGG_SCOPE_SECRET shorter than 32 chars', () => {
    expect(() => loadEnv({ ZHGG_SCOPE_SECRET: 'short' })).toThrow();
  });

  it('accepts valid private key', () => {
    const env = loadEnv({ ZG_PRIVATE_KEY: VALID_KEY });
    expect(env.ZG_PRIVATE_KEY).toBe(VALID_KEY);
  });

  it('accepts valid address', () => {
    const env = loadEnv({ AGENT_NFT_ADDRESS: VALID_ADDRESS });
    expect(env.AGENT_NFT_ADDRESS).toBe(VALID_ADDRESS);
  });
});

describe('requireXxx helpers', () => {
  beforeEach(() => resetEnv());

  it('requireZgKey throws when missing', () => {
    expect(() => requireZgKey(loadEnv({}))).toThrow(/ZG_PRIVATE_KEY/);
  });

  it('requireZgKey returns key when set', () => {
    const env = loadEnv({ ZG_PRIVATE_KEY: VALID_KEY });
    expect(requireZgKey(env)).toBe(VALID_KEY);
  });

  it('requireBaseSepoliaKey throws when missing', () => {
    expect(() => requireBaseSepoliaKey(loadEnv({}))).toThrow(/BASE_SEPOLIA_PRIVATE_KEY/);
  });

  it('requireBaseSepoliaKey returns key when set', () => {
    const env = loadEnv({ BASE_SEPOLIA_PRIVATE_KEY: VALID_KEY });
    expect(requireBaseSepoliaKey(env)).toBe(VALID_KEY);
  });

  it('requireScopeSecret throws when missing', () => {
    expect(() => requireScopeSecret(loadEnv({}))).toThrow(/ZHGG_SCOPE_SECRET/);
  });

  it('requireScopeSecret returns secret when set', () => {
    const env = loadEnv({ ZHGG_SCOPE_SECRET: VALID_SECRET });
    expect(requireScopeSecret(env)).toBe(VALID_SECRET);
  });

  it('requireAgentNftAddress throws when missing', () => {
    expect(() => requireAgentNftAddress(loadEnv({}))).toThrow(/AGENT_NFT_ADDRESS/);
  });

  it('requireAgentNftAddress returns address when set', () => {
    const env = loadEnv({ AGENT_NFT_ADDRESS: VALID_ADDRESS });
    expect(requireAgentNftAddress(env)).toBe(VALID_ADDRESS);
  });

  it('requireInftTokenId throws when missing', () => {
    expect(() => requireInftTokenId(loadEnv({}))).toThrow(/ZG_INFT_TOKEN_ID/);
  });

  it('requireInftTokenId returns id when set', () => {
    const env = loadEnv({ ZG_INFT_TOKEN_ID: '1' });
    expect(requireInftTokenId(env)).toBe('1');
  });
});
