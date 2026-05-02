/// ERC-8004 Reputation Registry receipt poster.
///
/// After every paid inference, the workflow posts a feedback record to the
/// AgentRegistry contract (D1's minimal ERC-8004 adapter on 0G Galileo).
/// Off-chain feedback JSON is canonicalized, hashed (keccak256), and the
/// hash plus a feedback URI are written on-chain via `giveFeedback`.
///
/// This module is deliberately viem-agnostic: callers inject an
/// `Erc8004Client` adapter so the same logic runs against viem in production
/// and against a mock in tests. A viem-backed client lives in
/// `./erc8004-viem.ts` (separate module — D2.3 ships the surface, D2.4+
/// wires the live client).

import { keccak256, toBytes, type Hex, type Address } from 'viem';
import type { Result } from './adapters/zg-router.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/// Inputs to build the canonical off-chain feedback JSON. Field order is
/// stable (matches the EIP-8004 §5.1 example).
export interface FeedbackJsonInput {
  agentRegistry: string;          // CAIP-2 address: "eip155:16602:0x..."
  agentId: bigint;
  clientAddress: string;          // CAIP-2 address: "eip155:84532:0x..."
  createdAt: string;              // ISO-8601 timestamp
  value: number;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  attestationRoot: string | null;
  paymentTxHash: string | null;
}

/// Build the canonical feedback JSON. Stable key order so keccak256 hashes
/// match across runs. agentId is ALWAYS encoded as a string. The EIP-8004
/// spec example uses a number, but JS encodes `1` and Rust encodes `"1"`
/// as different bytes — leading to silent feedbackHash mismatches between
/// JS and Rust/Go clients. Cross-language reproducibility wins.
export function buildFeedbackJson(input: FeedbackJsonInput): string {
  const payload: Record<string, unknown> = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#feedback-v1',
    agentRegistry: input.agentRegistry,
    agentId: input.agentId.toString(),
    clientAddress: input.clientAddress,
    createdAt: input.createdAt,
    value: input.value,
    valueDecimals: input.valueDecimals,
    tag1: input.tag1,
    tag2: input.tag2,
    endpoint: input.endpoint,
  };

  if (input.attestationRoot != null) {
    payload.attestation = { root: input.attestationRoot };
  }
  if (input.paymentTxHash != null) {
    payload.proofOfPayment = { txHash: input.paymentTxHash };
  }

  return JSON.stringify(payload);
}

/// Adapter interface for the on-chain call. Production impl wraps viem's
/// walletClient.writeContract; tests inject a mock.
export interface GiveFeedbackArgs {
  registry: Address;
  agentId: bigint;
  value: number;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: Hex;
}

export interface Erc8004Client {
  giveFeedback(args: GiveFeedbackArgs): Promise<Hex>;
}

export interface ReceiptContext {
  registryAddress: Address;
  agentRegistryCaip: string;
  agentId: bigint;
  clientAddress: string;
  value: number;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  attestationRoot: string | null;
  paymentTxHash: string | null;
  createdAt: string;
  /// Slice Y — when set, this hash (typically keccak256 of an AuditReport
  /// canonical bytes pinned at `feedbackURI`) is recorded on chain instead
  /// of the legacy `keccak(buildFeedbackJson(ctx))`. The on-chain
  /// `feedbackHash` then commits to the EVIDENCE the regulator queries,
  /// not to a redundant copy of the receipt fields. Backward-compatible:
  /// callers who don't pin off-chain evidence omit this and the legacy
  /// hash is still computed.
  feedbackHashOverride?: Hex;
}

export type PostError =
  | { kind: 'config'; reason: string }
  | { kind: 'invalid_value'; reason: string }
  | { kind: 'post_failed'; reason: string };

/// int128 bounds for ERC-8004's `value` field. Validated at the boundary
/// because downstream `BigInt(value)` throws on NaN / Infinity / non-
/// integer floats with a cryptic RPC error rather than a structured
/// PostError. Range: -(2^127) ... 2^127-1.
const INT128_MAX = (1n << 127n) - 1n;
const INT128_MIN = -(1n << 127n);

export async function postReceipt(
  client: Erc8004Client,
  ctx: ReceiptContext
): Promise<Result<Hex, PostError>> {
  if (ctx.registryAddress.toLowerCase() === ZERO_ADDRESS) {
    return { ok: false, error: { kind: 'config', reason: 'registryAddress is zero' } };
  }
  // Validate the int128-bound `value` BEFORE BigInt conversion downstream.
  // NaN, Infinity, non-integer floats, and out-of-range integers all throw
  // cryptic errors at the RPC layer; surface them as structured PostError
  // here so callers can react.
  if (!Number.isFinite(ctx.value) || !Number.isInteger(ctx.value)) {
    return {
      ok: false,
      error: { kind: 'invalid_value', reason: `value must be a finite integer, got ${ctx.value}` },
    };
  }
  const valueBig = BigInt(ctx.value);
  if (valueBig > INT128_MAX || valueBig < INT128_MIN) {
    return {
      ok: false,
      error: { kind: 'invalid_value', reason: `value ${ctx.value} out of int128 range` },
    };
  }

  let feedbackHash: Hex;
  if (ctx.feedbackHashOverride !== undefined) {
    feedbackHash = ctx.feedbackHashOverride;
  } else {
    const json = buildFeedbackJson({
      agentRegistry: ctx.agentRegistryCaip,
      agentId: ctx.agentId,
      clientAddress: ctx.clientAddress,
      createdAt: ctx.createdAt,
      value: ctx.value,
      valueDecimals: ctx.valueDecimals,
      tag1: ctx.tag1,
      tag2: ctx.tag2,
      endpoint: ctx.endpoint,
      attestationRoot: ctx.attestationRoot,
      paymentTxHash: ctx.paymentTxHash,
    });
    feedbackHash = keccak256(toBytes(json));
  }

  try {
    const txHash = await client.giveFeedback({
      registry: ctx.registryAddress,
      agentId: ctx.agentId,
      value: ctx.value,
      valueDecimals: ctx.valueDecimals,
      tag1: ctx.tag1,
      tag2: ctx.tag2,
      endpoint: ctx.endpoint,
      feedbackURI: ctx.feedbackURI,
      feedbackHash,
    });
    return { ok: true, value: txHash };
  } catch (e) {
    return {
      ok: false,
      error: { kind: 'post_failed', reason: e instanceof Error ? e.message : String(e) },
    };
  }
}
