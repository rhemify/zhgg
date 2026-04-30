import { describe, it, expect, mock } from 'bun:test';
import { keccak256, toBytes } from 'viem';
import { postReceipt, buildFeedbackJson, type Erc8004Client } from '../src/erc8004.js';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const REGISTRY = '0x1111111111111111111111111111111111111111';

function makeClient(returnTx = '0xdeadbeef'): {
  client: Erc8004Client;
  spy: ReturnType<typeof mock>;
} {
  const spy = mock(() => Promise.resolve(returnTx as `0x${string}`));
  const client: Erc8004Client = {
    giveFeedback: spy as Erc8004Client['giveFeedback'],
  };
  return { client, spy };
}

describe('buildFeedbackJson', () => {
  it('produces stable canonical JSON', () => {
    const json = buildFeedbackJson({
      agentRegistry: `eip155:16602:${REGISTRY}`,
      agentId: 1n,
      clientAddress: 'eip155:84532:0xabc',
      value: 100,
      valueDecimals: 0,
      tag1: 'audit',
      tag2: 'eu-ai-act',
      endpoint: 'https://audit.zhgg.eth/audit',
      attestationRoot: '0x9a',
      paymentTxHash: '0xpay',
      createdAt: '2026-04-30T00:00:00Z',
    });
    const parsed = JSON.parse(json);
    expect(parsed.agentId).toBe('1');
    expect(parsed.tag1).toBe('audit');
    expect(parsed.attestation.root).toBe('0x9a');
    expect(parsed.proofOfPayment.txHash).toBe('0xpay');
  });

  /// Cross-language determinism golden vector. Any change to the canonical
  /// JSON encoding (key order, agentId stringification, attestation/proof
  /// nesting) breaks this assertion loudly. Rust and Go implementers MUST
  /// produce the same hash for the same input or the cross-platform receipt
  /// audit-trail breaks. If you change the encoder, update both the JSON
  /// snapshot and the hash, then notify any non-JS consumers.
  it('produces a stable golden hash for a fixed input (cross-language vector)', () => {
    const GOLDEN_INPUT = {
      agentRegistry: 'eip155:16602:0x1111111111111111111111111111111111111111',
      agentId: 42n,
      clientAddress: 'eip155:84532:0x2222222222222222222222222222222222222222',
      createdAt: '2026-04-30T00:00:00Z',
      value: 100,
      valueDecimals: 0,
      tag1: 'audit',
      tag2: 'eu-ai-act',
      endpoint: 'https://audit.zhgg.eth/v1',
      attestationRoot: '0xdeadbeef',
      paymentTxHash: '0xfeedface',
    };
    const GOLDEN_JSON =
      '{"type":"https://eips.ethereum.org/EIPS/eip-8004#feedback-v1",' +
      '"agentRegistry":"eip155:16602:0x1111111111111111111111111111111111111111",' +
      '"agentId":"42",' +
      '"clientAddress":"eip155:84532:0x2222222222222222222222222222222222222222",' +
      '"createdAt":"2026-04-30T00:00:00Z","value":100,"valueDecimals":0,' +
      '"tag1":"audit","tag2":"eu-ai-act","endpoint":"https://audit.zhgg.eth/v1",' +
      '"attestation":{"root":"0xdeadbeef"},"proofOfPayment":{"txHash":"0xfeedface"}}';
    const GOLDEN_HASH = '0x05f6ca9352fcf18b9958abae56969aa0d7582a9f4091d7fc5dd4dac06a03e82c';

    const json = buildFeedbackJson(GOLDEN_INPUT);
    expect(json).toBe(GOLDEN_JSON);
    expect(keccak256(toBytes(json))).toBe(GOLDEN_HASH);
  });

  it('encodes BigInt agentId as string for cross-language determinism', () => {
    const json = buildFeedbackJson({
      agentRegistry: `eip155:16602:${REGISTRY}`,
      agentId: 999_999_999_999_999_999n,
      clientAddress: 'eip155:84532:0xabc',
      value: 1,
      valueDecimals: 0,
      tag1: 'x',
      tag2: 'y',
      endpoint: '',
      attestationRoot: null,
      paymentTxHash: null,
      createdAt: '2026-04-30T00:00:00Z',
    });
    const parsed = JSON.parse(json);
    expect(parsed.agentId).toBe('999999999999999999');
  });
});

describe('postReceipt', () => {
  it('hashes the off-chain JSON and calls giveFeedback with the right args', async () => {
    const { client, spy } = makeClient();
    const ctx = {
      registryAddress: REGISTRY as `0x${string}`,
      agentRegistryCaip: `eip155:16602:${REGISTRY}`,
      agentId: 7n,
      clientAddress: 'eip155:84532:0xabc' as const,
      value: 100,
      valueDecimals: 0,
      tag1: 'audit',
      tag2: 'eu-ai-act',
      endpoint: 'https://api.zhgg.eth',
      feedbackURI: 'ipfs://placeholder',
      attestationRoot: '0x9a',
      paymentTxHash: '0xpay',
      createdAt: '2026-04-30T00:00:00Z',
    };

    const result = await postReceipt(client, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toBe('0xdeadbeef');

    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]![0] as Parameters<Erc8004Client['giveFeedback']>[0];
    expect(call.registry).toBe(REGISTRY);
    expect(call.agentId).toBe(7n);
    expect(call.value).toBe(100);
    expect(call.tag1).toBe('audit');
    expect(call.feedbackURI).toBe('ipfs://placeholder');
    // Hash is keccak256 of the canonical JSON
    const expectedJson = buildFeedbackJson({
      agentRegistry: ctx.agentRegistryCaip,
      agentId: ctx.agentId,
      clientAddress: ctx.clientAddress,
      value: ctx.value,
      valueDecimals: ctx.valueDecimals,
      tag1: ctx.tag1,
      tag2: ctx.tag2,
      endpoint: ctx.endpoint,
      attestationRoot: ctx.attestationRoot,
      paymentTxHash: ctx.paymentTxHash,
      createdAt: ctx.createdAt,
    });
    expect(call.feedbackHash).toBe(keccak256(toBytes(expectedJson)));
  });

  it('returns Err post_failed on client throw', async () => {
    const spy = mock(() => Promise.reject(new Error('chain stalled')));
    const client: Erc8004Client = { giveFeedback: spy as Erc8004Client['giveFeedback'] };
    const result = await postReceipt(client, {
      registryAddress: REGISTRY as `0x${string}`,
      agentRegistryCaip: `eip155:16602:${REGISTRY}`,
      agentId: 1n,
      clientAddress: 'eip155:84532:0xabc',
      value: 1,
      valueDecimals: 0,
      tag1: 'x',
      tag2: 'y',
      endpoint: '',
      feedbackURI: 'ipfs://x',
      attestationRoot: null,
      paymentTxHash: null,
      createdAt: '2026-04-30T00:00:00Z',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('post_failed');
    expect(result.error.reason).toBe('chain stalled');
  });

  it('rejects NaN value with invalid_value error', async () => {
    const { client } = makeClient();
    const result = await postReceipt(client, {
      registryAddress: REGISTRY as `0x${string}`,
      agentRegistryCaip: `eip155:16602:${REGISTRY}`,
      agentId: 1n,
      clientAddress: 'eip155:84532:0xabc',
      value: NaN,
      valueDecimals: 0,
      tag1: 'x',
      tag2: 'y',
      endpoint: '',
      feedbackURI: 'ipfs://x',
      attestationRoot: null,
      paymentTxHash: null,
      createdAt: '2026-04-30T00:00:00Z',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('invalid_value');
  });

  it('rejects non-integer float value', async () => {
    const { client } = makeClient();
    const result = await postReceipt(client, {
      registryAddress: REGISTRY as `0x${string}`,
      agentRegistryCaip: `eip155:16602:${REGISTRY}`,
      agentId: 1n,
      clientAddress: 'eip155:84532:0xabc',
      value: 0.5,
      valueDecimals: 0,
      tag1: 'x',
      tag2: 'y',
      endpoint: '',
      feedbackURI: 'ipfs://x',
      attestationRoot: null,
      paymentTxHash: null,
      createdAt: '2026-04-30T00:00:00Z',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('invalid_value');
  });

  it('rejects empty registry address (config error)', async () => {
    const { client } = makeClient();
    const result = await postReceipt(client, {
      registryAddress: ZERO_ADDR as `0x${string}`,
      agentRegistryCaip: `eip155:16602:${ZERO_ADDR}`,
      agentId: 1n,
      clientAddress: 'eip155:84532:0xabc',
      value: 1,
      valueDecimals: 0,
      tag1: 'x',
      tag2: 'y',
      endpoint: '',
      feedbackURI: 'ipfs://x',
      attestationRoot: null,
      paymentTxHash: null,
      createdAt: '2026-04-30T00:00:00Z',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('config');
  });
});
