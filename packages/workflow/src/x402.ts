/// x402 v2 payment gate.
///
/// Server-side helpers that implement the x402 verify/settle dance:
/// 1. Caller checks for `X-Payment` header on incoming request
/// 2. If missing or invalid → return 402 with the `paymentRequirements` body
/// 3. If present → forward to facilitator `/verify` to validate the
///    EIP-3009 transferWithAuthorization signature
/// 4. Caller does the actual work
/// 5. After work succeeds → call `settlePayment` which forwards to
///    facilitator `/settle` to broadcast the transferWithAuthorization
///    on-chain. The facilitator pays gas; the payer signs only.
///
/// Free public testnet facilitator: https://x402.org/facilitator
/// (Base Sepolia + Solana Devnet, no API key).
///
/// Settlement target on Base Sepolia is typically zhgg's FeeSplitter
/// contract — incoming USDC gets distributed 85/5/5/5 atomically.

import { keccak256, toBytes } from 'viem';
import type { Result } from './adapters/zg-router.js';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/// Returns a stable fingerprint of a payment payload. Callers MUST dedupe
/// verified payloads on this value to prevent replay between verify and
/// settle. The same EIP-3009 authorization signed once can pass `verify`
/// twice if invoked concurrently — a malicious client could trigger paid
/// work twice while only the second `transferWithAuthorization` reverts.
export function paymentFingerprint(paymentPayload: string): string {
  return keccak256(toBytes(paymentPayload));
}

// v1 used `X-Payment`; v2 renamed to `PAYMENT-SIGNATURE`. We declare v2 in
// the requirements body so the header MUST match — otherwise facilitators
// reject the request and clients get 402-loop with no progress.
const PAYMENT_HEADER = 'PAYMENT-SIGNATURE';
const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE';
const DEFAULT_FACILITATOR = 'https://x402.org/facilitator';
const DEFAULT_TIMEOUT_SECONDS = 60;

export interface PaymentRequirementsInput {
  /// Amount in atomic units (e.g. "100000" = 0.1 USDC at 6 decimals).
  amount: string;
  /// CAIP-2 network identifier ("eip155:84532" for Base Sepolia).
  network: string;
  /// ERC-20 contract address of the asset (e.g. USDC on Base Sepolia).
  asset: `0x${string}`;
  /// Recipient address (typically zhgg's FeeSplitter).
  payTo: `0x${string}`;
  /// Resource being paid for.
  resource: { url: string; description: string; mimeType?: string };
  /// Maximum time the payer has to complete payment (seconds).
  maxTimeoutSeconds?: number;
  /// EIP-712 domain metadata (defaults to USDC).
  extra?: { name: string; version: string };
}

export interface PaymentRequirements {
  x402Version: 2;
  accepts: Array<{
    scheme: 'exact';
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra: { name: string; version: string };
  }>;
  resource: { url: string; description: string; mimeType?: string };
  extensions: Record<string, unknown>;
}

/// Build a 402 response with the canonical x402 headers. Centralized so the
/// `WWW-Authenticate` realm + content-type stay consistent across every
/// challenge surface. Clients use the realm to detect this is x402 (not a
/// generic auth challenge).
export function payment402(requirements: PaymentRequirements): Response {
  return new Response(JSON.stringify(requirements), {
    status: 402,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'x402 realm="zhgg"',
    },
  });
}

export function buildPaymentRequirements(input: PaymentRequirementsInput): PaymentRequirements {
  return {
    x402Version: 2,
    accepts: [
      {
        scheme: 'exact',
        network: input.network,
        amount: input.amount,
        asset: input.asset,
        payTo: input.payTo,
        maxTimeoutSeconds: input.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
        extra: input.extra ?? { name: 'USDC', version: '2' },
      },
    ],
    resource: input.resource,
    extensions: {},
  };
}

export interface VerifyOptions {
  facilitatorUrl?: string;
  fetchImpl?: FetchLike;
}

/// Reason a verify failed. Operationally distinct so callers can route
/// alerts and retries:
/// - `no-header`: client didn't supply PAYMENT-SIGNATURE; canonical 402.
/// - `invalid`: facilitator validated and rejected the payload; 402, do
///   not retry — the user signed something wrong.
/// - `facilitator-down`: transport or 5xx from facilitator; 503 +
///   Retry-After so the client backs off and retries — operator pages.
/// - `malformed`: facilitator returned an unparseable body; 502, treat
///   as upstream bug.
export type VerifyFailReason = 'no-header' | 'invalid' | 'facilitator-down' | 'malformed';

export type VerifyOutcome =
  | {
      ok: false;
      reason: VerifyFailReason;
      response: Response;
      /// Operator-facing detail for `facilitator-down` and `malformed`.
      detail?: string;
    }
  | {
      ok: true;
      payer: string | null;
      paymentPayload: string;
      /// keccak256 fingerprint of the payload. Caller MUST dedupe across
      /// concurrent requests to prevent verify→settle replay.
      fingerprint: string;
    };

/// Build a 503 Service Unavailable response for facilitator-down cases.
/// `Retry-After: 5` tells well-behaved clients to back off briefly rather
/// than hot-loop on the 402 challenge.
function facilitatorDown503(detail: string): Response {
  return new Response(JSON.stringify({ error: 'facilitator unavailable', detail }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': '5',
    },
  });
}

function upstreamMalformed502(detail: string): Response {
  return new Response(JSON.stringify({ error: 'facilitator returned malformed response', detail }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function verifyPayment(
  request: Request,
  requirements: PaymentRequirements,
  opts: VerifyOptions = {}
): Promise<VerifyOutcome> {
  const facilitatorUrl = opts.facilitatorUrl ?? DEFAULT_FACILITATOR;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const paymentPayload = request.headers.get(PAYMENT_HEADER);
  if (!paymentPayload) {
    return { ok: false, reason: 'no-header', response: payment402(requirements) };
  }

  let verifyResp: Response;
  try {
    verifyResp = await fetchImpl(`${facilitatorUrl}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentPayload, paymentRequirements: requirements }),
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: 'facilitator-down', response: facilitatorDown503(detail), detail };
  }

  if (!verifyResp.ok) {
    const detail = `facilitator returned HTTP ${verifyResp.status}`;
    return { ok: false, reason: 'facilitator-down', response: facilitatorDown503(detail), detail };
  }

  let body: { isValid?: unknown; payer?: unknown };
  try {
    body = (await verifyResp.json()) as { isValid?: unknown; payer?: unknown };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: 'malformed', response: upstreamMalformed502(detail), detail };
  }

  if (body.isValid !== true) {
    return { ok: false, reason: 'invalid', response: payment402(requirements) };
  }

  return {
    ok: true,
    payer: typeof body.payer === 'string' ? body.payer : null,
    paymentPayload,
    fingerprint: paymentFingerprint(paymentPayload),
  };
}

export interface SettleOptions {
  facilitatorUrl?: string;
  fetchImpl?: FetchLike;
}

export interface SettleOutput {
  txHash: string;
  network: string;
  payer: string | null;
}

export type SettleError =
  | { kind: 'transport'; reason: string; status?: number }
  | { kind: 'settle_failed'; reason: string }
  | { kind: 'malformed_response'; reason: string };

export async function settlePayment(
  paymentPayload: string,
  requirements: PaymentRequirements,
  opts: SettleOptions = {}
): Promise<Result<SettleOutput, SettleError>> {
  const facilitatorUrl = opts.facilitatorUrl ?? DEFAULT_FACILITATOR;
  const fetchImpl = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(`${facilitatorUrl}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentPayload, paymentRequirements: requirements }),
    });
  } catch (e) {
    return { ok: false, error: { kind: 'transport', reason: e instanceof Error ? e.message : String(e) } };
  }

  if (!res.ok) {
    return {
      ok: false,
      error: { kind: 'transport', reason: `HTTP ${res.status}`, status: res.status },
    };
  }

  let body: { success?: unknown; transaction?: unknown; network?: unknown; payer?: unknown; error?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch (e) {
    return { ok: false, error: { kind: 'malformed_response', reason: e instanceof Error ? e.message : String(e) } };
  }

  if (body.success !== true) {
    const reason = typeof body.error === 'string' ? body.error : 'facilitator returned success=false';
    return { ok: false, error: { kind: 'settle_failed', reason } };
  }

  if (typeof body.transaction !== 'string' || typeof body.network !== 'string') {
    return { ok: false, error: { kind: 'malformed_response', reason: 'missing transaction/network' } };
  }

  return {
    ok: true,
    value: {
      txHash: body.transaction,
      network: body.network,
      payer: typeof body.payer === 'string' ? body.payer : null,
    },
  };
}

/// Build a `PAYMENT-RESPONSE` header value (Base64-encoded JSON of settlement output).
export function paymentResponseHeader(out: SettleOutput): string {
  const json = JSON.stringify({
    success: true,
    transaction: out.txHash,
    network: out.network,
    payer: out.payer,
  });
  return Buffer.from(json).toString('base64');
}

export { PAYMENT_HEADER, PAYMENT_RESPONSE_HEADER };
