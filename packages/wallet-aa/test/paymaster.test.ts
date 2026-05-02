import { describe, it, expect, mock } from 'bun:test';
import {
  USDC_BASE_SEPOLIA,
  encodePaymasterAndData,
  pimlicoGetTokenQuotes,
  pmGetPaymasterData,
  pmGetPaymasterStubData,
  type PaymasterStubResult,
} from '../src/paymaster.js';
import {
  ENTRYPOINT_V07_ADDRESS,
  buildUserOp,
  type FetchLike,
  type PackedUserOperation,
} from '../src/userop.js';
import type { Address, Hex } from 'viem';

const PAYMASTER: Address = '0xfaCe000000000000000000000000000000000001';
const ACCOUNT: Address = '0xcafE000000000000000000000000000000000001';

function emptyOp(): PackedUserOperation {
  return buildUserOp({
    sender: ACCOUNT,
    nonce: 0n,
    callData: '0x',
    verificationGasLimit: 100_000n,
    callGasLimit: 100_000n,
    preVerificationGas: 50_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    maxFeePerGas: 10_000_000_000n,
  });
}

describe('USDC_BASE_SEPOLIA', () => {
  it('is the Circle official Base Sepolia USDC', () => {
    expect(USDC_BASE_SEPOLIA).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  });
});

describe('encodePaymasterAndData', () => {
  it('produces paymaster (20) || verifGas (16) || postOpGas (16) || data layout', () => {
    const stub: PaymasterStubResult = {
      paymaster: PAYMASTER,
      paymasterVerificationGasLimit: '0x1234' as Hex,
      paymasterPostOpGasLimit: '0x5678' as Hex,
      paymasterData: '0xdeadbeef' as Hex,
    };
    const out = encodePaymasterAndData(stub);
    // 20 + 16 + 16 + 4 = 56 bytes = 112 hex chars + 0x
    expect(out.length).toBe(2 + 56 * 2);
    expect(out.toLowerCase().startsWith(PAYMASTER.toLowerCase())).toBe(true);
    expect(out.toLowerCase().endsWith('deadbeef')).toBe(true);
  });
});

describe('pimlicoGetTokenQuotes', () => {
  it('passes tokens + chainId hex to the bundler', async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = mock(async (_url, init) => {
      captured = init;
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            [USDC_BASE_SEPOLIA]: {
              exchangeRate: '0x1',
              priceMarkup: '0x2',
            },
          },
        })
      );
    }) as unknown as FetchLike;

    const r = await pimlicoGetTokenQuotes(
      { tokens: [USDC_BASE_SEPOLIA], chainId: 84532 },
      { bundlerUrl: 'http://b/', fetchImpl }
    );
    expect(r.ok).toBe(true);

    const body = JSON.parse(captured!.body as string) as {
      method: string;
      params: unknown[];
    };
    expect(body.method).toBe('pimlico_getTokenQuotes');
    expect(body.params[0]).toEqual([USDC_BASE_SEPOLIA]);
    expect(body.params[1]).toBe('0x14a34'); // 84532 in hex
  });
});

describe('pmGetPaymasterStubData', () => {
  it('strips signature + paymasterAndData from the op before sending', async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = mock(async (_url, init) => {
      captured = init;
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            paymaster: PAYMASTER,
            paymasterData: '0xfeed',
            paymasterVerificationGasLimit: '0x1234',
            paymasterPostOpGasLimit: '0x5678',
            isFinal: false,
          },
        })
      );
    }) as unknown as FetchLike;

    const op = { ...emptyOp(), signature: '0xshould_be_stripped' as Hex };
    await pmGetPaymasterStubData(
      op,
      ENTRYPOINT_V07_ADDRESS,
      { token: USDC_BASE_SEPOLIA },
      { bundlerUrl: 'http://b/', fetchImpl }
    );

    const body = JSON.parse(captured!.body as string) as {
      method: string;
      params: Array<Record<string, unknown>>;
    };
    expect(body.method).toBe('pm_getPaymasterStubData');
    // First param should NOT contain signature or paymasterAndData
    expect(body.params[0]?.signature).toBeUndefined();
    expect(body.params[0]?.paymasterAndData).toBeUndefined();
    expect(body.params[0]?.callData).toBe('0x');
  });
});

describe('pmGetPaymasterData', () => {
  it('round-trips a final paymaster result', async () => {
    const fetchImpl = mock(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              paymaster: PAYMASTER,
              paymasterData: '0xreal_sig_bytes',
              paymasterVerificationGasLimit: '0x1234',
              paymasterPostOpGasLimit: '0x5678',
              isFinal: true,
            },
          })
        )
    ) as unknown as FetchLike;

    const r = await pmGetPaymasterData(
      emptyOp(),
      ENTRYPOINT_V07_ADDRESS,
      { token: USDC_BASE_SEPOLIA },
      { bundlerUrl: 'http://b/', fetchImpl }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.paymaster).toBe(PAYMASTER);
      expect(r.value.isFinal).toBe(true);
    }
  });
});
