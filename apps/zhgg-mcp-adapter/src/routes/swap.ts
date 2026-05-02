/// `POST /agents/swap/call` — execute a real swap on Base Sepolia.
///
/// Reuses `swap-agent`'s `executeSwap` verbatim. The route shapes the
/// success/error envelope into a flat JSON payload (bigints stringified)
/// so the response is portable across KH workflows.
///
/// HARD RULE inherited from swap-agent: a failed swap surfaces the real
/// revert reason, NEVER a fabricated txHash. We pass `error.kind` +
/// `error.reason` straight through.

import { executeSwap, type SwapClients } from 'swap-agent';
import { AGENTS, validateAgentInput } from '../input-schemas.js';

const SWAP_DESC = AGENTS.find((a) => a.id === 'swap')!;

export interface SwapCallInput {
  amount: string;
  from: 'ETH' | 'WETH' | 'USDC';
  to: 'ETH' | 'WETH' | 'USDC';
}

export type ExecuteSwapFn = typeof executeSwap;

export interface SwapRouteDeps {
  /// The viem client triple (publicClient + walletClient + account).
  /// Built once at boot from BASE_SEPOLIA_* env. Tests inject a fake
  /// triple along with `executeSwapFn` so no RPC traffic occurs.
  clients: SwapClients;
  /// Defaults to the real `executeSwap` import.
  executeSwapFn?: ExecuteSwapFn;
}

export async function handleSwapCall(
  req: Request,
  deps: SwapRouteDeps,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch (e) {
    return Response.json(
      {
        error: {
          kind: 'bad_json',
          reason: e instanceof Error ? e.message : String(e),
        },
      },
      { status: 400 },
    );
  }

  const valid = validateAgentInput(body, SWAP_DESC.inputSchema);
  if (!valid.ok) {
    return Response.json(
      {
        error: {
          kind: 'bad_input',
          ...(valid.missing !== undefined ? { missing: valid.missing } : {}),
          ...(valid.key !== undefined ? { key: valid.key } : {}),
          reason: valid.reason,
        },
      },
      { status: 400 },
    );
  }

  const input = body as SwapCallInput;
  const fn = deps.executeSwapFn ?? executeSwap;
  const result = await fn(deps.clients, input.amount, input.from, input.to);

  if (!result.ok) {
    return Response.json(
      { error: { kind: result.error.kind, reason: result.error.reason } },
      { status: 502 },
    );
  }

  return Response.json({
    result: {
      txHash: result.value.txHash,
      route: result.value.route,
      poolFee: result.value.poolFee,
      fromAmount: result.value.fromAmount.toString(),
      toAmountMin: result.value.toAmountMin.toString(),
      basescan: `https://sepolia.basescan.org/tx/${result.value.txHash}`,
    },
  });
}
