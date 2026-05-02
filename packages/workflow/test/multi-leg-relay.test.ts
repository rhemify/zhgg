import { describe, it, expect, mock } from 'bun:test';
import {
  createWalletClient,
  http,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import {
  PAYMENT_INTENT_TYPES,
  createInMemoryNonceStore,
  paymentIntentDigest,
  relayPaymentIntent,
  type ChainExecutor,
  type PaymentIntent,
} from '../src/multi-leg-relay.js';

const VERIFYING: Address = '0xfaC0101010101010101010101010101010101010';
const SETTLER_BASE: Address = '0xcafE000000000000000000000000000000000001';
const SETTLER_0G: Address = '0xCAFE000000000000000000000000000000000002';
const RECIP: Address = '0xA9E1abaBaBabababAbababABaBAbabAbaBaBab01';
const USDC_BASE: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const USDC_0G: Address = '0xcA11E7c00Ffe5c0De0000000000000000000beeF';
const PRIV: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

async function signIntent(intent: PaymentIntent): Promise<Hex> {
  const account = privateKeyToAccount(PRIV);
  const wallet = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http('http://localhost:0'),
  });
  return wallet.signTypedData({
    account,
    domain: {
      name: 'zhgg.PaymentIntent',
      version: '1',
      chainId: 84532,
      verifyingContract: VERIFYING,
    },
    types: PAYMENT_INTENT_TYPES,
    primaryType: 'PaymentIntent',
    message: {
      from: intent.from,
      nonce: intent.nonce,
      deadline: intent.deadline,
      legs: intent.legs.map((l) => ({
        chain: l.chain,
        settler: l.settler,
        recipient: l.recipient,
        token: l.token,
        amount: l.amount,
      })),
    },
  });
}

const account = privateKeyToAccount(PRIV);
const FROM = account.address;

function fixtureIntent(legs?: PaymentIntent['legs']): PaymentIntent {
  return {
    from: FROM,
    nonce: 1n,
    deadline: 9_999_999_999n,
    legs: legs ?? [
      {
        chain: 'eip155:84532',
        settler: SETTLER_BASE,
        recipient: RECIP,
        token: USDC_BASE,
        amount: 100_000n,
      },
    ],
  };
}

function mkExecutor(txHash: Hex): { exec: ChainExecutor; spy: ReturnType<typeof mock> } {
  const spy = mock(async () => txHash);
  return { exec: { submit: spy as unknown as ChainExecutor['submit'] }, spy };
}

describe('paymentIntentDigest', () => {
  it('changes when nonce changes', () => {
    const a = paymentIntentDigest(
      { chainId: 84532, verifyingContract: VERIFYING },
      fixtureIntent()
    );
    const b = paymentIntentDigest(
      { chainId: 84532, verifyingContract: VERIFYING },
      { ...fixtureIntent(), nonce: 2n }
    );
    expect(a).not.toBe(b);
  });

  it('changes when chainId changes (cross-domain replay defense)', () => {
    const a = paymentIntentDigest(
      { chainId: 84532, verifyingContract: VERIFYING },
      fixtureIntent()
    );
    const b = paymentIntentDigest(
      { chainId: 16602, verifyingContract: VERIFYING },
      fixtureIntent()
    );
    expect(a).not.toBe(b);
  });
});

describe('relayPaymentIntent — happy path', () => {
  it('verifies sig, runs all legs, returns ok=true', async () => {
    const { exec: execBase, spy: baseSpy } = mkExecutor(('0x' + 'aa'.repeat(32)) as Hex);
    const { exec: exec0G, spy: zgSpy } = mkExecutor(('0x' + 'bb'.repeat(32)) as Hex);

    const intent = fixtureIntent([
      {
        chain: 'eip155:84532',
        settler: SETTLER_BASE,
        recipient: RECIP,
        token: USDC_BASE,
        amount: 100_000n,
      },
      {
        chain: 'eip155:16602',
        settler: SETTLER_0G,
        recipient: RECIP,
        token: USDC_0G,
        amount: 200_000n,
      },
    ]);
    const sig = await signIntent(intent);

    const r = await relayPaymentIntent(intent, sig, {
      domain: { chainId: 84532, verifyingContract: VERIFYING },
      executors: { 'eip155:84532': execBase, 'eip155:16602': exec0G },
      nonceStore: createInMemoryNonceStore(),
    });

    expect(r.ok).toBe(true);
    expect(r.legs.length).toBe(2);
    expect(r.legs[0]!.error).toBeNull();
    expect(r.legs[1]!.error).toBeNull();
    expect(baseSpy).toHaveBeenCalledTimes(1);
    expect(zgSpy).toHaveBeenCalledTimes(1);
  });
});

describe('relayPaymentIntent — top-level rejections', () => {
  it('rejects expired intents before signature verification', async () => {
    const intent = { ...fixtureIntent(), deadline: 1_000n }; // way past
    const sig = await signIntent(intent);
    const { exec } = mkExecutor('0x' + '00'.repeat(32) as Hex);
    const r = await relayPaymentIntent(intent, sig, {
      domain: { chainId: 84532, verifyingContract: VERIFYING },
      executors: { 'eip155:84532': exec },
      nonceStore: createInMemoryNonceStore(),
      now: () => 9_999_999_999n,
    });
    expect(r.ok).toBe(false);
    expect(r.topLevelError?.kind).toBe('expired');
    expect(r.legs.length).toBe(0);
  });

  it('rejects replay (same nonce + from)', async () => {
    const intent = fixtureIntent();
    const sig = await signIntent(intent);
    const store = createInMemoryNonceStore();
    const { exec } = mkExecutor('0x' + 'aa'.repeat(32) as Hex);

    // First run succeeds.
    await relayPaymentIntent(intent, sig, {
      domain: { chainId: 84532, verifyingContract: VERIFYING },
      executors: { 'eip155:84532': exec },
      nonceStore: store,
    });
    // Second run with same nonce → replay rejection.
    const r = await relayPaymentIntent(intent, sig, {
      domain: { chainId: 84532, verifyingContract: VERIFYING },
      executors: { 'eip155:84532': exec },
      nonceStore: store,
    });
    expect(r.ok).toBe(false);
    expect(r.topLevelError?.kind).toBe('replay');
  });

  it('rejects bad signature', async () => {
    const intent = fixtureIntent();
    // Sign with a DIFFERENT account.
    const wrongPriv: Hex =
      '0xc87509a1c067bbde78beb793e6fa76530b6382a4c0241e5e4a9ec0a0f44dc0d3';
    const wrongAccount = privateKeyToAccount(wrongPriv);
    const wrongWallet = createWalletClient({
      account: wrongAccount,
      chain: baseSepolia,
      transport: http('http://localhost:0'),
    });
    const wrongSig = await wrongWallet.signTypedData({
      account: wrongAccount,
      domain: {
        name: 'zhgg.PaymentIntent',
        version: '1',
        chainId: 84532,
        verifyingContract: VERIFYING,
      },
      types: PAYMENT_INTENT_TYPES,
      primaryType: 'PaymentIntent',
      message: {
        from: intent.from, // claims to be FROM but signed by wrongAccount
        nonce: intent.nonce,
        deadline: intent.deadline,
        legs: intent.legs.map((l) => ({ ...l })),
      },
    });

    const { exec } = mkExecutor('0x' + 'aa'.repeat(32) as Hex);
    const r = await relayPaymentIntent(intent, wrongSig, {
      domain: { chainId: 84532, verifyingContract: VERIFYING },
      executors: { 'eip155:84532': exec },
      nonceStore: createInMemoryNonceStore(),
    });
    expect(r.ok).toBe(false);
    expect(r.topLevelError?.kind).toBe('invalid_signature');
  });

  it('rejects no_legs', async () => {
    const intent = { ...fixtureIntent(), legs: [] };
    const sig = await signIntent(intent);
    const r = await relayPaymentIntent(intent, sig, {
      domain: { chainId: 84532, verifyingContract: VERIFYING },
      executors: {},
      nonceStore: createInMemoryNonceStore(),
    });
    expect(r.ok).toBe(false);
    expect(r.topLevelError?.kind).toBe('no_legs');
  });
});

describe('relayPaymentIntent — per-leg failures are isolated', () => {
  it('records leg-level error without rolling back other legs', async () => {
    const { exec: okExec } = mkExecutor(('0x' + 'aa'.repeat(32)) as Hex);
    const failingExec: ChainExecutor = {
      submit: async () => {
        throw new Error('rpc 503');
      },
    };

    const intent = fixtureIntent([
      {
        chain: 'eip155:84532',
        settler: SETTLER_BASE,
        recipient: RECIP,
        token: USDC_BASE,
        amount: 100_000n,
      },
      {
        chain: 'eip155:16602',
        settler: SETTLER_0G,
        recipient: RECIP,
        token: USDC_0G,
        amount: 200_000n,
      },
    ]);
    const sig = await signIntent(intent);

    const r = await relayPaymentIntent(intent, sig, {
      domain: { chainId: 84532, verifyingContract: VERIFYING },
      executors: { 'eip155:84532': okExec, 'eip155:16602': failingExec },
      nonceStore: createInMemoryNonceStore(),
    });

    expect(r.ok).toBe(false); // overall failure because leg 2 failed
    expect(r.legs.length).toBe(2);
    expect(r.legs[0]!.error).toBeNull();
    expect(r.legs[0]!.txHash).not.toBeNull();
    expect(r.legs[1]!.error).toContain('503');
    expect(r.legs[1]!.txHash).toBeNull();
  });

  it('marks unknown_chain on legs whose chain has no executor', async () => {
    const { exec } = mkExecutor(('0x' + 'aa'.repeat(32)) as Hex);
    const intent = fixtureIntent([
      {
        chain: 'eip155:99999',
        settler: SETTLER_BASE,
        recipient: RECIP,
        token: USDC_BASE,
        amount: 100_000n,
      },
    ]);
    const sig = await signIntent(intent);

    const r = await relayPaymentIntent(intent, sig, {
      domain: { chainId: 84532, verifyingContract: VERIFYING },
      executors: { 'eip155:84532': exec }, // wrong chain
      nonceStore: createInMemoryNonceStore(),
    });
    expect(r.ok).toBe(false);
    expect(r.legs[0]!.error).toContain('unknown_chain');
  });
});

describe('createInMemoryNonceStore', () => {
  it('seen returns false until record is called', async () => {
    const store = createInMemoryNonceStore();
    expect(await store.seen(FROM, 1n)).toBe(false);
    await store.record(FROM, 1n);
    expect(await store.seen(FROM, 1n)).toBe(true);
    expect(await store.seen(FROM, 2n)).toBe(false);
    expect(store.size()).toBe(1);
  });
});
