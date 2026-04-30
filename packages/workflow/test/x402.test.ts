import { describe, it, expect } from 'bun:test';
import {
  buildPaymentRequirements,
  verifyPayment,
  settlePayment,
  type FetchLike,
} from '../src/x402.js';

const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const FEE_SPLITTER = '0x9999999999999999999999999999999999999999';
const FACILITATOR = 'https://x402.org/facilitator';

function mockFetch(handler: (req: Request) => Response | Promise<Response>): FetchLike {
  return async (input, init) => {
    const req = input instanceof Request ? input : new Request(input as string, init);
    return handler(req);
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('buildPaymentRequirements', () => {
  it('produces a v2-shaped requirements object', () => {
    const req = buildPaymentRequirements({
      amount: '100000',
      payTo: FEE_SPLITTER,
      asset: USDC_BASE_SEPOLIA,
      network: 'eip155:84532',
      resource: { url: 'https://api.zhgg.eth/audit', description: 'Run audit' },
    });
    expect(req.x402Version).toBe(2);
    expect(req.accepts.length).toBe(1);
    expect(req.accepts[0]!.scheme).toBe('exact');
    expect(req.accepts[0]!.network).toBe('eip155:84532');
    expect(req.accepts[0]!.amount).toBe('100000');
    expect(req.accepts[0]!.payTo).toBe(FEE_SPLITTER);
    expect(req.accepts[0]!.asset).toBe(USDC_BASE_SEPOLIA);
    expect(req.accepts[0]!.extra).toEqual({ name: 'USDC', version: '2' });
    expect(req.resource.url).toBe('https://api.zhgg.eth/audit');
  });
});

describe('verifyPayment', () => {
  it('returns 402 when X-Payment header missing', async () => {
    const requirements = buildPaymentRequirements({
      amount: '100000',
      payTo: FEE_SPLITTER,
      asset: USDC_BASE_SEPOLIA,
      network: 'eip155:84532',
      resource: { url: 'https://api/x', description: 'd' },
    });
    const req = new Request('https://api/x', { method: 'GET' });
    const result = await verifyPayment(req, requirements, {
      facilitatorUrl: FACILITATOR,
      fetchImpl: mockFetch(() => jsonResponse({ isValid: false })),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(402);
    const body = (await result.response.json()) as { x402Version: number; accepts: unknown };
    expect(body.x402Version).toBe(2);
    expect(body.accepts).toBeDefined();
  });

  it('forwards X-Payment to facilitator /verify and returns Ok on valid', async () => {
    let captured: { url: string; body: string } | null = null;
    const fetchImpl: FetchLike = mockFetch(async (req) => {
      captured = { url: req.url, body: await req.text() };
      return jsonResponse({ isValid: true, payer: '0xpayer' });
    });
    const requirements = buildPaymentRequirements({
      amount: '100000',
      payTo: FEE_SPLITTER,
      asset: USDC_BASE_SEPOLIA,
      network: 'eip155:84532',
      resource: { url: 'https://api/x', description: 'd' },
    });
    const req = new Request('https://api/x', {
      headers: { 'X-Payment': 'base64-payload' },
    });
    const result = await verifyPayment(req, requirements, {
      facilitatorUrl: FACILITATOR,
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.payer).toBe('0xpayer');
    expect(result.paymentPayload).toBe('base64-payload');
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(`${FACILITATOR}/verify`);
    const sent = JSON.parse(captured!.body);
    expect(sent.paymentPayload).toBe('base64-payload');
    expect(sent.paymentRequirements).toEqual(requirements);
  });

  it('returns 402 when facilitator says invalid', async () => {
    const requirements = buildPaymentRequirements({
      amount: '100000',
      payTo: FEE_SPLITTER,
      asset: USDC_BASE_SEPOLIA,
      network: 'eip155:84532',
      resource: { url: 'https://api/x', description: 'd' },
    });
    const req = new Request('https://api/x', { headers: { 'X-Payment': 'bad' } });
    const result = await verifyPayment(req, requirements, {
      facilitatorUrl: FACILITATOR,
      fetchImpl: mockFetch(() => jsonResponse({ isValid: false })),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(402);
  });
});

describe('settlePayment', () => {
  it('forwards to facilitator /settle and returns tx hash', async () => {
    let captured: { url: string; body: string } | null = null;
    const fetchImpl: FetchLike = mockFetch(async (req) => {
      captured = { url: req.url, body: await req.text() };
      return jsonResponse({
        success: true,
        transaction: '0xsettle',
        network: 'eip155:84532',
        payer: '0xpayer',
      });
    });
    const requirements = buildPaymentRequirements({
      amount: '100000',
      payTo: FEE_SPLITTER,
      asset: USDC_BASE_SEPOLIA,
      network: 'eip155:84532',
      resource: { url: 'https://api/x', description: 'd' },
    });
    const result = await settlePayment('payload', requirements, {
      facilitatorUrl: FACILITATOR,
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.txHash).toBe('0xsettle');
    expect(result.value.network).toBe('eip155:84532');
    expect(captured!.url).toBe(`${FACILITATOR}/settle`);
  });

  it('returns Err settle_failed on facilitator error', async () => {
    const requirements = buildPaymentRequirements({
      amount: '100000',
      payTo: FEE_SPLITTER,
      asset: USDC_BASE_SEPOLIA,
      network: 'eip155:84532',
      resource: { url: 'https://api/x', description: 'd' },
    });
    const result = await settlePayment('payload', requirements, {
      facilitatorUrl: FACILITATOR,
      fetchImpl: mockFetch(() => jsonResponse({ success: false, error: 'insufficient' })),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('settle_failed');
  });

  it('returns Err transport on facilitator HTTP error', async () => {
    const requirements = buildPaymentRequirements({
      amount: '100000',
      payTo: FEE_SPLITTER,
      asset: USDC_BASE_SEPOLIA,
      network: 'eip155:84532',
      resource: { url: 'https://api/x', description: 'd' },
    });
    const result = await settlePayment('payload', requirements, {
      facilitatorUrl: FACILITATOR,
      fetchImpl: mockFetch(() => new Response('down', { status: 502 })),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('transport');
  });
});
