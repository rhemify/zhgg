import { z } from 'zod';

export const ZG_GALILEO_CHAIN_ID = 16602;
export const BASE_SEPOLIA_CHAIN_ID = 84532;

export const DEFAULT_ZG_RPC_URL = 'https://evmrpc-testnet.0g.ai';
export const DEFAULT_BASE_SEPOLIA_RPC_URL = 'https://sepolia.base.org';
export const DEFAULT_KEEPERHUB_MCP_ENDPOINT = 'https://app.keeperhub.com/mcp';

export const ZHGG_ERC8021_MARKER = '8021';
export const DEFAULT_ZHGG_FEE_BPS = 30;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const HEX_PRIVATE_KEY = /^0x[a-fA-F0-9]{64}$/;
const HEX_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

const envSchema = z.object({
  ZG_RPC_URL: z.string().url().default(DEFAULT_ZG_RPC_URL),
  ZG_PRIVATE_KEY: z.string().regex(HEX_PRIVATE_KEY).optional(),
  ZG_INFT_TOKEN_ID: z.string().optional(),

  BASE_SEPOLIA_RPC_URL: z.string().url().default(DEFAULT_BASE_SEPOLIA_RPC_URL),
  BASE_SEPOLIA_PRIVATE_KEY: z.string().regex(HEX_PRIVATE_KEY).optional(),

  ZHGG_SCOPE_SECRET: z.string().min(32).optional(),
  ZHGG_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(DEFAULT_ZHGG_FEE_BPS),
  ZHGG_FEE_RECIPIENT: z.string().regex(HEX_ADDRESS).default(ZERO_ADDRESS),

  KEEPERHUB_MCP_ENDPOINT: z.string().url().default(DEFAULT_KEEPERHUB_MCP_ENDPOINT),

  AGENT_NFT_ADDRESS: z.string().regex(HEX_ADDRESS).optional(),
});

export type RouterEnv = z.infer<typeof envSchema>;

let cachedEnv: RouterEnv | null = null;

// Cache only the production env load (source === process.env). Tests passing a
// custom source always re-parse — caching by-reference would silently return
// stale data on the second call with a different source.
export function loadEnv(source: NodeJS.ProcessEnv = process.env): RouterEnv {
  const isProduction = source === process.env;
  if (isProduction && cachedEnv) return cachedEnv;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const errors = JSON.stringify(parsed.error.flatten().fieldErrors, null, 2);
    throw new Error(`Invalid env: ${errors}`);
  }
  if (isProduction) cachedEnv = parsed.data;
  return parsed.data;
}

export function resetEnv(): void {
  cachedEnv = null;
}

export function requireZgKey(env: RouterEnv = loadEnv()): string {
  if (!env.ZG_PRIVATE_KEY) {
    throw new Error('ZG_PRIVATE_KEY is required for 0G operations');
  }
  return env.ZG_PRIVATE_KEY;
}

export function requireBaseSepoliaKey(env: RouterEnv = loadEnv()): string {
  if (!env.BASE_SEPOLIA_PRIVATE_KEY) {
    throw new Error('BASE_SEPOLIA_PRIVATE_KEY is required for x402 USDC payments');
  }
  return env.BASE_SEPOLIA_PRIVATE_KEY;
}

export function requireScopeSecret(env: RouterEnv = loadEnv()): string {
  if (!env.ZHGG_SCOPE_SECRET) {
    throw new Error('ZHGG_SCOPE_SECRET is required for signing execution scopes');
  }
  return env.ZHGG_SCOPE_SECRET;
}

export function requireAgentNftAddress(env: RouterEnv = loadEnv()): string {
  if (!env.AGENT_NFT_ADDRESS) {
    throw new Error('AGENT_NFT_ADDRESS is required — deploy AgentNFT.sol first');
  }
  return env.AGENT_NFT_ADDRESS;
}

export function requireInftTokenId(env: RouterEnv = loadEnv()): string {
  if (!env.ZG_INFT_TOKEN_ID) {
    throw new Error('ZG_INFT_TOKEN_ID is required — set to the demo iNFT tokenId after mint');
  }
  return env.ZG_INFT_TOKEN_ID;
}
