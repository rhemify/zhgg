/// Operator UX intents (Phase 3): read-only inspections + explicit mint.
///
/// Each function returns an array of audit-trail rows for the caller
/// (apps/tui/src/index.ts) to push into AUDIT[]. Keeping the dispatch
/// functions decoupled from `pushAudit` here means they're trivially
/// unit-testable and the TUI stays the single owner of UI state.
///
/// Real-RPC contract: every helper must touch a real chain. On error we
/// surface the chain's actual revert message — never a static fallback.
/// If the RPC is unreachable the row is tagged `err` so the operator
/// sees exactly what failed (e.g. "ZG_RPC_URL: connect ETIMEDOUT").

import {
  createPublicClient,
  formatEther,
  formatUnits,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { mintAgent, type AgentRole, type MintAgentResult } from '@zhgg/mint-agent';
import { AGENT_REGISTRY } from './agent-registry.js';

// ─── Shared types ────────────────────────────────────────────────────────

export interface OpRow {
  /// Source label rendered in the AUDIT TRAIL agent column. Short so the
  /// fixed pad(.,16) doesn't truncate the message itself.
  agent: string;
  event: string;
  ok: 'ok' | 'err' | 'info';
}

// ─── ABIs ───────────────────────────────────────────────────────────────
//
// Minimal-surface ABIs — only the read methods we call. AgentNFT
// (ERC-7857) lives at `AGENT_NFT_ADDRESS` on 0G Galileo (chainId 16602);
// USDC / WETH live on Base Sepolia.

const AGENT_NFT_READ_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function capabilities(uint256 tokenId) view returns (bytes)',
  'function tokenURI(uint256 tokenId) view returns (string)',
]);

const ERC20_BALANCE_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

// ─── agents ─────────────────────────────────────────────────────────────

/// List every iNFT registered in `agent-registry.ts` and probe its
/// on-chain state on 0G Galileo. Per-token failures are surfaced as
/// individual error rows — a stale registry entry shouldn't blank the
/// whole panel.
export interface ListAgentsInput {
  /// Address of AgentNFT (ERC-7857) on 0G Galileo. Required — when
  /// missing we surface a single explanatory error row.
  agentNftAddress?: Address;
  zgRpcUrl: string;
}

export async function listAgents(input: ListAgentsInput): Promise<OpRow[]> {
  const rows: OpRow[] = [];
  if (!input.agentNftAddress) {
    return [{ agent: 'agents', event: 'AGENT_NFT_ADDRESS not set in env', ok: 'err' }];
  }
  let zgPub: PublicClient;
  try {
    zgPub = createPublicClient({ transport: http(input.zgRpcUrl) });
  } catch (e) {
    return [
      {
        agent: 'agents',
        event: `0G client init failed: ${e instanceof Error ? e.message : String(e)}`,
        ok: 'err',
      },
    ];
  }

  const entries = Object.entries(AGENT_REGISTRY);
  rows.push({
    agent: 'agents',
    event: `${entries.length} iNFTs registered (probing AgentNFT @ ${input.agentNftAddress})`,
    ok: 'info',
  });

  for (const [role, entry] of entries) {
    const tokenId = entry.inftTokenId;
    try {
      // Two parallel reads — ownerOf + capabilities. We don't probe
      // tokenURI because it's not required by the spec ("alias, owner,
      // capabilities byte length") and avoiding it halves RPC traffic.
      const [owner, caps] = await Promise.all([
        zgPub.readContract({
          address: input.agentNftAddress,
          abi: AGENT_NFT_READ_ABI,
          functionName: 'ownerOf',
          args: [tokenId],
        }) as Promise<Address>,
        zgPub.readContract({
          address: input.agentNftAddress,
          abi: AGENT_NFT_READ_ABI,
          functionName: 'capabilities',
          args: [tokenId],
        }) as Promise<Hex>,
      ]);
      // capabilities() returns hex bytes — byte length = (hexlen-2)/2.
      const capBytes = Math.max(0, Math.floor((caps.length - 2) / 2));
      rows.push({
        agent: 'agents',
        event: `#${tokenId} ${role} owner=${shortAddr(owner)} caps=${capBytes}B`,
        ok: 'ok',
      });
    } catch (e) {
      rows.push({
        agent: 'agents',
        event: `#${tokenId} ${role} read FAILED: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160),
        ok: 'err',
      });
    }
  }
  return rows;
}

// ─── balances ───────────────────────────────────────────────────────────

/// USDC + WETH addresses on Base Sepolia. Hardcoded constants — these
/// are testnet contract addresses that don't change. The user wallet is
/// supplied by the caller (typically the TUI's live bundle account).
const USDC_BASE_SEPOLIA: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const WETH_BASE_SEPOLIA: Address = '0x4200000000000000000000000000000000000006';

export interface ShowBalancesInput {
  account: Address;
  zgRpcUrl: string;
  /// Pre-built Base Sepolia public client (the live bundle already has
  /// one). Reusing it skips a redundant transport setup per call.
  basePublicClient: PublicClient;
}

export async function showBalances(input: ShowBalancesInput): Promise<OpRow[]> {
  const rows: OpRow[] = [];
  // 0G uses its own Galileo chain — needs a separate transport. We
  // build it here so callers don't have to plumb a second client.
  let zgPub: PublicClient;
  try {
    zgPub = createPublicClient({ transport: http(input.zgRpcUrl) });
  } catch (e) {
    return [
      {
        agent: 'balances',
        event: `0G client init failed: ${e instanceof Error ? e.message : String(e)}`,
        ok: 'err',
      },
    ];
  }

  // Four reads in parallel — three on Base Sepolia, one on 0G. A
  // single failure shouldn't blank the rest, so each is fenced.
  const [ogRes, ethRes, usdcRes, wethRes] = await Promise.allSettled([
    zgPub.getBalance({ address: input.account }),
    input.basePublicClient.getBalance({ address: input.account }),
    input.basePublicClient.readContract({
      address: USDC_BASE_SEPOLIA,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [input.account],
    }) as Promise<bigint>,
    input.basePublicClient.readContract({
      address: WETH_BASE_SEPOLIA,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [input.account],
    }) as Promise<bigint>,
  ]);

  // Header — show which wallet we're looking at.
  rows.push({
    agent: 'balances',
    event: `wallet ${shortAddr(input.account)}`,
    ok: 'info',
  });

  // Compose the headline row when ALL four reads succeed; otherwise
  // emit a separate err row per failed read so the operator can spot
  // exactly which RPC misbehaved.
  const ogOk = ogRes.status === 'fulfilled';
  const ethOk = ethRes.status === 'fulfilled';
  const usdcOk = usdcRes.status === 'fulfilled';
  const wethOk = wethRes.status === 'fulfilled';

  if (ogOk && ethOk && usdcOk && wethOk) {
    const og = formatEther(ogRes.value);
    const eth = formatEther(ethRes.value);
    const usdc = formatUnits(usdcRes.value, 6);
    const weth = formatEther(wethRes.value);
    rows.push({
      agent: 'balances',
      event: `${trimDec(og, 4)} OG · ${trimDec(eth, 4)} ETH · ${trimDec(usdc, 6)} USDC · ${trimDec(weth, 4)} WETH`,
      ok: 'ok',
    });
  } else {
    if (ogOk) {
      rows.push({ agent: 'balances', event: `0G ${trimDec(formatEther(ogRes.value), 4)} OG`, ok: 'ok' });
    } else {
      rows.push({ agent: 'balances', event: `0G read FAILED: ${reasonOf(ogRes.reason)}`.slice(0, 160), ok: 'err' });
    }
    if (ethOk) {
      rows.push({ agent: 'balances', event: `Base ${trimDec(formatEther(ethRes.value), 4)} ETH`, ok: 'ok' });
    } else {
      rows.push({ agent: 'balances', event: `Base ETH read FAILED: ${reasonOf(ethRes.reason)}`.slice(0, 160), ok: 'err' });
    }
    if (usdcOk) {
      rows.push({ agent: 'balances', event: `Base ${trimDec(formatUnits(usdcRes.value, 6), 6)} USDC`, ok: 'ok' });
    } else {
      rows.push({ agent: 'balances', event: `USDC read FAILED: ${reasonOf(usdcRes.reason)}`.slice(0, 160), ok: 'err' });
    }
    if (wethOk) {
      rows.push({ agent: 'balances', event: `Base ${trimDec(formatEther(wethRes.value), 4)} WETH`, ok: 'ok' });
    } else {
      rows.push({ agent: 'balances', event: `WETH read FAILED: ${reasonOf(wethRes.reason)}`.slice(0, 160), ok: 'err' });
    }
  }
  return rows;
}

// ─── block ──────────────────────────────────────────────────────────────

export interface ShowBlockInput {
  zgRpcUrl: string;
  basePublicClient: PublicClient;
}

export async function showBlock(input: ShowBlockInput): Promise<OpRow[]> {
  let zgPub: PublicClient;
  try {
    zgPub = createPublicClient({ transport: http(input.zgRpcUrl) });
  } catch (e) {
    return [
      {
        agent: 'block',
        event: `0G client init failed: ${e instanceof Error ? e.message : String(e)}`,
        ok: 'err',
      },
    ];
  }

  const [zgRes, baseRes] = await Promise.allSettled([
    zgPub.getBlockNumber(),
    input.basePublicClient.getBlockNumber(),
  ]);

  const rows: OpRow[] = [];
  if (zgRes.status === 'fulfilled' && baseRes.status === 'fulfilled') {
    rows.push({
      agent: 'block',
      event: `0G #${zgRes.value} · Base Sepolia #${baseRes.value}`,
      ok: 'ok',
    });
  } else {
    if (zgRes.status === 'fulfilled') {
      rows.push({ agent: 'block', event: `0G #${zgRes.value}`, ok: 'ok' });
    } else {
      rows.push({
        agent: 'block',
        event: `0G eth_blockNumber FAILED: ${reasonOf(zgRes.reason)}`.slice(0, 160),
        ok: 'err',
      });
    }
    if (baseRes.status === 'fulfilled') {
      rows.push({ agent: 'block', event: `Base Sepolia #${baseRes.value}`, ok: 'ok' });
    } else {
      rows.push({
        agent: 'block',
        event: `Base eth_blockNumber FAILED: ${reasonOf(baseRes.reason)}`.slice(0, 160),
        ok: 'err',
      });
    }
  }
  return rows;
}

// ─── mint ───────────────────────────────────────────────────────────────

export interface DispatchMintInput {
  role: AgentRole;
  account: Address;
  agentNftAddress?: Address;
  zgPublicClient: PublicClient;
  zgWalletClient: WalletClient;
  /// Streaming hook so the TUI can paint per-stage progress. Each call
  /// pushes one `OpRow` immediately rather than waiting for the whole
  /// mint to finish — matters because the mint can take 30–60s on a
  /// loaded testnet RPC.
  onProgress?: (row: OpRow) => void;
}

export async function dispatchMint(
  input: DispatchMintInput,
): Promise<{ ok: true; result: MintAgentResult } | { ok: false; reason: string }> {
  const emit = (row: OpRow): void => {
    input.onProgress?.(row);
  };
  if (!input.agentNftAddress) {
    const reason = 'AGENT_NFT_ADDRESS not set in env';
    emit({ agent: 'mint-agent', event: reason, ok: 'err' });
    return { ok: false, reason };
  }
  emit({
    agent: 'mint-agent',
    event: `mint.start role=${input.role} owner=${shortAddr(input.account)}`,
    ok: 'info',
  });
  emit({
    agent: 'mint-agent',
    event: `mint.tx submitting to AgentNFT @ ${shortAddr(input.agentNftAddress)} on 0G Galileo`,
    ok: 'info',
  });

  try {
    const result = await mintAgent({
      role: input.role,
      account: input.account,
      agentNftAddress: input.agentNftAddress,
      zgPublicClient: input.zgPublicClient,
      zgWalletClient: input.zgWalletClient,
    });
    emit({
      agent: 'mint-agent',
      event: `mint.confirmed tokenId=${result.tokenId} tx=${shortHash(result.txHash)}`,
      ok: 'ok',
    });
    emit({
      agent: 'mint-agent',
      event: `mint.registered (registry update is manual — re-add '${input.role}' → #${result.tokenId} in agent-registry.ts to expose in TUI)`,
      ok: 'info',
    });
    return { ok: true, result };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    emit({ agent: 'mint-agent', event: `mint.failed ${reason}`.slice(0, 160), ok: 'err' });
    return { ok: false, reason };
  }
}

// ─── helpers ────────────────────────────────────────────────────────────

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function shortHash(h: string): string {
  return h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h;
}

/// Trim a viem-formatted decimal string to `decimals` fractional digits.
/// formatEther / formatUnits return up to 18 / 6 decimals; we don't want
/// "0.475829834234234234" leaking into the UI when the spec asks for
/// "0.4758". Doesn't round — just truncates at the boundary.
function trimDec(v: string, decimals: number): string {
  const dot = v.indexOf('.');
  if (dot === -1) return v;
  return v.slice(0, dot + 1 + decimals);
}

function reasonOf(r: unknown): string {
  if (r instanceof Error) return r.message;
  return String(r);
}
