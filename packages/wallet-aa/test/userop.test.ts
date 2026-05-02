import { describe, it, expect, mock } from 'bun:test';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import {
  ENTRYPOINT_V07_ADDRESS,
  buildUserOp,
  encodeExecute,
  encodeExecuteBatch,
  encodeInitCode,
  getEntryPointNonce,
  getUserOperationReceipt,
  packTwoUint128,
  pimlicoBundlerUrl,
  pimlicoGetUserOperationGasPrice,
  sendUserOperation,
  signUserOp,
  toRpcShape,
  userOpHash,
  type FetchLike,
  type PackedUserOperation,
} from '../src/userop.js';

const ACCOUNT: Address = '0xcafE000000000000000000000000000000000001';
const TARGET: Address = '0xA9E1abaBaBabababAbababABaBAbabAbaBaBab01';
const FACTORY: Address = '0xfaC0101010101010101010101010101010101010';
const OWNER: Address = '0xcA11E7c00Ffe5c0De0000000000000000000beeF';
const PRIV: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

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

describe('packTwoUint128', () => {
  it('packs two values with high half then low half', () => {
    const out = packTwoUint128(0xabcd_1234_5678n, 0xffeeddccbb_aa9988n);
    // High 16 bytes are the first arg left-padded; low 16 bytes the second
    expect(out.length).toBe(66);
    expect(out.slice(0, 34).toLowerCase()).toBe(
      ('0x' + (0xabcd_1234_5678n).toString(16).padStart(32, '0')).toLowerCase()
    );
  });

  it('rejects values >= 2^128', () => {
    expect(() => packTwoUint128(1n << 128n, 0n)).toThrow();
    expect(() => packTwoUint128(0n, 1n << 128n)).toThrow();
  });
});

describe('userOpHash', () => {
  it('produces a 32-byte hash', () => {
    const h = userOpHash(emptyOp(), ENTRYPOINT_V07_ADDRESS, 84532);
    expect(h.length).toBe(66);
    expect(h.startsWith('0x')).toBe(true);
  });

  it('changes when chainId changes (cross-chain replay defense)', () => {
    const op = emptyOp();
    const a = userOpHash(op, ENTRYPOINT_V07_ADDRESS, 84532);
    const b = userOpHash(op, ENTRYPOINT_V07_ADDRESS, 8453);
    expect(a).not.toBe(b);
  });

  it('changes when callData changes', () => {
    const op1 = emptyOp();
    const op2 = { ...op1, callData: '0xdeadbeef' as Hex };
    const a = userOpHash(op1, ENTRYPOINT_V07_ADDRESS, 84532);
    const b = userOpHash(op2, ENTRYPOINT_V07_ADDRESS, 84532);
    expect(a).not.toBe(b);
  });

  it('changes when entryPoint changes', () => {
    const op = emptyOp();
    const a = userOpHash(op, ENTRYPOINT_V07_ADDRESS, 84532);
    const b = userOpHash(op, '0x0000000000000000000000000000000000000123', 84532);
    expect(a).not.toBe(b);
  });
});

describe('encodeExecute / encodeExecuteBatch', () => {
  it('encodes execute(target, value, data) calldata', () => {
    const data = encodeExecute(TARGET, 0n, '0xdeadbeef');
    expect(data.startsWith('0x')).toBe(true);
    // Selector for execute(address,uint256,bytes) is 0xb61d27f6
    expect(data.slice(0, 10)).toBe('0xb61d27f6');
  });

  it('encodes executeBatch(targets, values, datas)', () => {
    const data = encodeExecuteBatch([TARGET], [0n], ['0xdeadbeef']);
    expect(data.startsWith('0x')).toBe(true);
    // Selector for executeBatch(address[],uint256[],bytes[]) is 0x47e1da2a
    expect(data.slice(0, 10)).toBe('0x47e1da2a');
  });
});

describe('encodeInitCode', () => {
  it('prepends factory address before createAccount calldata', () => {
    const init = encodeInitCode(FACTORY, OWNER, ('0x' + '00'.repeat(32)) as Hex);
    expect(init.toLowerCase().startsWith(FACTORY.toLowerCase())).toBe(true);
  });
});

describe('signUserOp', () => {
  it('produces a 65-byte signature', async () => {
    const account = privateKeyToAccount(PRIV);
    const wallet = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http('http://localhost:0'),
    });
    const sig = await signUserOp(wallet, account, emptyOp(), ENTRYPOINT_V07_ADDRESS, 84532);
    expect(sig.length).toBe(132); // 0x + 130 chars
  });
});

describe('toRpcShape', () => {
  it('hex-encodes numeric fields', () => {
    const op = emptyOp();
    const rpc = toRpcShape(op);
    expect(rpc.nonce).toBe('0x0');
    expect(rpc.preVerificationGas).toBe('0xc350'); // 50_000
  });
});

describe('pimlicoBundlerUrl', () => {
  it('returns base URL when no apiKey is given', () => {
    expect(pimlicoBundlerUrl(84532)).toBe('https://api.pimlico.io/v2/84532/rpc');
  });

  it('appends apiKey query when provided', () => {
    expect(pimlicoBundlerUrl(8453, 'pim_xyz')).toBe(
      'https://api.pimlico.io/v2/8453/rpc?apikey=pim_xyz'
    );
  });
});

describe('sendUserOperation — RPC envelope', () => {
  it('POSTs eth_sendUserOperation with the rpc-shaped op + entryPoint', async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = mock(async (_url, init) => {
      captured = init;
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xfeed' }),
        { status: 200 }
      );
    }) as unknown as FetchLike;

    const op = emptyOp();
    op.signature = ('0x' + 'aa'.repeat(65)) as Hex;
    const r = await sendUserOperation(op, ENTRYPOINT_V07_ADDRESS, {
      bundlerUrl: 'http://b/',
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('0xfeed');

    const body = JSON.parse(captured!.body as string) as {
      method: string;
      params: unknown[];
    };
    expect(body.method).toBe('eth_sendUserOperation');
    expect(body.params[1]).toBe(ENTRYPOINT_V07_ADDRESS);
  });

  it('returns rpc_error when bundler returns a JSON-RPC error', async () => {
    const fetchImpl = mock(
      async () =>
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad params' } }),
          { status: 200 }
        )
    ) as unknown as FetchLike;
    const r = await sendUserOperation(emptyOp(), ENTRYPOINT_V07_ADDRESS, {
      bundlerUrl: 'http://b/',
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('rpc_error');
      if (r.error.kind === 'rpc_error') {
        expect(r.error.code).toBe(-32602);
        expect(r.error.message).toBe('bad params');
      }
    }
  });

  it('returns transport on network failure', async () => {
    const fetchImpl = mock(async () => {
      throw new Error('econnrefused');
    }) as unknown as FetchLike;
    const r = await sendUserOperation(emptyOp(), ENTRYPOINT_V07_ADDRESS, {
      bundlerUrl: 'http://b/',
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('transport');
  });
});

describe('getUserOperationReceipt', () => {
  it('returns null when bundler hasnt included the op', async () => {
    const fetchImpl = mock(
      async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }))
    ) as unknown as FetchLike;
    const r = await getUserOperationReceipt('0xfeed', { bundlerUrl: 'http://b/', fetchImpl });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });
});

describe('pimlicoGetUserOperationGasPrice', () => {
  it('parses slow/standard/fast triplets', async () => {
    const fetchImpl = mock(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              slow: { maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x2' },
              standard: { maxFeePerGas: '0x3', maxPriorityFeePerGas: '0x4' },
              fast: { maxFeePerGas: '0x5', maxPriorityFeePerGas: '0x6' },
            },
          })
        )
    ) as unknown as FetchLike;
    const r = await pimlicoGetUserOperationGasPrice({ bundlerUrl: 'http://b/', fetchImpl });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.fast.maxFeePerGas).toBe('0x5');
      expect(r.value.standard.maxPriorityFeePerGas).toBe('0x4');
    }
  });
});

describe('getEntryPointNonce', () => {
  it('decodes the eth_call result as a bigint', async () => {
    const fetchImpl = mock(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: '0x000000000000000000000000000000000000000000000000000000000000002a',
          })
        )
    ) as unknown as FetchLike;
    const r = await getEntryPointNonce({
      rpcUrl: 'http://r/',
      entryPoint: ENTRYPOINT_V07_ADDRESS,
      sender: ACCOUNT,
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42n);
  });
});

describe('ENTRYPOINT_V07_ADDRESS', () => {
  it('is the canonical v0.7 EntryPoint address', () => {
    expect(ENTRYPOINT_V07_ADDRESS).toBe('0x0000000071727De22E5E9d8BAf0edAc6f37da032');
  });
});
