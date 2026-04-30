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
/// match across runs. BigInt agentId is encoded as a string when it would
/// overflow safe-integer (>= 2^53), otherwise as a number.
export function buildFeedbackJson(input: FeedbackJsonInput): string {
  const agentIdSafe =
    input.agentId <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(input.agentId)
      : input.agentId.toString();

  const payload: Record<string, unknown> = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#feedback-v1',
    agentRegistry: input.agentRegistry,
    agentId: agentIdSafe,
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
}

export type PostError =
  | { kind: 'config'; reason: string }
  | { kind: 'post_failed'; reason: string };

export async function postReceipt(
  client: Erc8004Client,
  ctx: ReceiptContext
): Promise<Result<Hex, PostError>> {
  if (ctx.registryAddress.toLowerCase() === ZERO_ADDRESS) {
    return { ok: false, error: { kind: 'config', reason: 'registryAddress is zero' } };
  }

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
  const feedbackHash = keccak256(toBytes(json));

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
