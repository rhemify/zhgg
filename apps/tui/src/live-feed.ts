/// Polls 0G Galileo + Base Sepolia for the header pills.
///
/// Reads:
///   - 0G block number          (RPC eth_blockNumber)
///   - 0G OG balance            (RPC eth_getBalance, of MINT_AGENT addr)
///   - Base Sepolia USDC balance (USDC.balanceOf)
///
/// Fail-soft: any RPC error keeps the previous value. Never throws into the
/// render loop. When the env vars are missing we render `—` placeholders
/// rather than fail-fast — the dashboard is useful even without a live mode.

const ZG_RPC      = process.env.ZG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai';
const BASE_RPC    = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';
const USDC_BS     = (process.env.USDC_BASE_SEPOLIA_ADDRESS ?? '0x036CbD53842c5426634e7929541eC2318f3dCF7e').toLowerCase();
const ADDR        = process.env.MINT_AGENT_ADDRESS
                  ?? deriveAddrFromEnv('MINT_AGENT_PRIVATE_KEY')
                  ?? '0x557E1E07652B75ABaA667223B11704165fC94d09';

export interface FeedSnapshot {
  blockNumber: number | null;
  ogBalance: string | null;
  usdcBalance: string | null;
}

export interface LiveFeed {
  snapshot(): FeedSnapshot;
  stop(): void;
}

/// Best-effort addr derivation: scans .env for a key, returns the EIP-55
/// address if it's a valid 0x-prefixed 64-hex string. Avoids importing
/// viem here just for one call — we only need a display address.
function deriveAddrFromEnv(envKey: string): string | undefined {
  const pk = process.env[envKey];
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) return undefined;
  // We don't actually derive — that requires secp256k1. Caller falls back
  // to the env-supplied MINT_AGENT_ADDRESS or the project default.
  return undefined;
}

async function rpcCall(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method} HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`rpc ${method}: ${body.error.message}`);
  return body.result;
}

function hexToBigInt(h: unknown): bigint {
  if (typeof h !== 'string' || !h.startsWith('0x')) return 0n;
  return BigInt(h);
}

function fmtUnits(wei: bigint, decimals: number, frac = 4): string {
  const div = 10n ** BigInt(decimals);
  const whole = wei / div;
  const rem = wei % div;
  if (frac === 0) return whole.toString();
  const fracStr = rem.toString().padStart(decimals, '0').slice(0, frac).replace(/0+$/, '');
  return fracStr.length === 0 ? whole.toString() : `${whole}.${fracStr}`;
}

export interface StartLiveFeedOptions {
  pollMs?: number;
  onUpdate?: () => void;
}

export function startLiveFeed(opts: StartLiveFeedOptions = {}): LiveFeed {
  const pollMs = opts.pollMs ?? 5000;
  const state: FeedSnapshot = { blockNumber: null, ogBalance: null, usdcBalance: null };
  let alive = true;

  async function tickOnce(): Promise<void> {
    try {
      const block = await rpcCall(ZG_RPC, 'eth_blockNumber', []);
      state.blockNumber = Number(hexToBigInt(block));
    } catch {
      /* keep last */
    }
    try {
      const wei = await rpcCall(ZG_RPC, 'eth_getBalance', [ADDR, 'latest']);
      state.ogBalance = `${fmtUnits(hexToBigInt(wei), 18, 4)} OG`;
    } catch {
      /* keep last */
    }
    try {
      // USDC.balanceOf(addr) — selector 0x70a08231 + 32-byte addr
      const data = '0x70a08231' + ADDR.toLowerCase().replace(/^0x/, '').padStart(64, '0');
      const raw = await rpcCall(BASE_RPC, 'eth_call', [{ to: USDC_BS, data }, 'latest']);
      state.usdcBalance = `${fmtUnits(hexToBigInt(raw), 6, 2)} USDC`;
    } catch {
      /* keep last */
    }
    if (alive && opts.onUpdate) opts.onUpdate();
  }

  tickOnce();
  const handle = setInterval(() => {
    if (alive) tickOnce();
  }, pollMs);

  return {
    snapshot: () => ({ ...state }),
    stop: () => {
      alive = false;
      clearInterval(handle);
    },
  };
}
