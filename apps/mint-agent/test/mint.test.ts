import { describe, it, expect, mock } from 'bun:test';
import {
  grantSpendCap,
  mintAgentNFT,
  mintSubname,
  registerAgent,
  type MintExecutor,
} from '../src/steps.js';
import type { Address, Hex } from 'viem';

const AGENT_NFT: Address = '0x1111111111111111111111111111111111111111';
const AGENT_REGISTRY: Address = '0x2222222222222222222222222222222222222222';
const ENS_REGISTRAR: Address = '0x3333333333333333333333333333333333333333';
const SPEND_CAP: Address = '0x4444444444444444444444444444444444444444';
const OWNER: Address = '0x5555555555555555555555555555555555555555';
const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TX1: Hex = '0xaaaa000000000000000000000000000000000000000000000000000000000001';
const TX2: Hex = '0xbbbb000000000000000000000000000000000000000000000000000000000002';
const TX3: Hex = '0xcccc000000000000000000000000000000000000000000000000000000000003';
const TX4: Hex = '0xdddd000000000000000000000000000000000000000000000000000000000004';

interface ScriptedReturn {
  result: unknown;
  txHash: Hex;
}

function makeExecutor(scripts: ScriptedReturn[]): { executor: MintExecutor; spy: ReturnType<typeof mock> } {
  let i = 0;
  const spy = mock(async () => {
    const r = scripts[i++];
    if (!r) throw new Error('executor called more times than scripted');
    return r;
  });
  return {
    executor: { call: spy as MintExecutor['call'] },
    spy,
  };
}

describe('mintAgentNFT', () => {
  it('returns tokenId on success', async () => {
    const { executor, spy } = makeExecutor([{ result: 7n, txHash: TX1 }]);
    const result = await mintAgentNFT(executor, {
      agentNft: AGENT_NFT,
      owner: OWNER,
      capabilityManifest: '0xdeadbeef',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.tokenId).toBe(7n);
    expect(result.value.txHash).toBe(TX1);

    const call = spy.mock.calls[0]![0] as { functionName: string; args: readonly unknown[]; address: Address };
    expect(call.functionName).toBe('mint');
    expect(call.address).toBe(AGENT_NFT);
    expect(call.args).toEqual([OWNER, '0xdeadbeef']);
  });

  it('returns Err mint on executor throw', async () => {
    const executor: MintExecutor = {
      call: async () => {
        throw new Error('rpc unreachable');
      },
    };
    const result = await mintAgentNFT(executor, {
      agentNft: AGENT_NFT,
      owner: OWNER,
      capabilityManifest: '0x',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('mint');
    expect(result.error.reason).toBe('rpc unreachable');
  });
});

describe('registerAgent', () => {
  it('encodes metadata as tuple[] and returns agentId', async () => {
    const { executor, spy } = makeExecutor([{ result: 42n, txHash: TX2 }]);
    const result = await registerAgent(executor, {
      agentRegistry: AGENT_REGISTRY,
      agentURI: 'ipfs://abc',
      metadata: [
        { metadataKey: 'inft', metadataValue: '0xaaaa' },
        { metadataKey: 'ens', metadataValue: '0xbbbb' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.agentId).toBe(42n);

    const call = spy.mock.calls[0]![0] as { functionName: string; args: readonly unknown[] };
    expect(call.functionName).toBe('register');
    expect(call.args[0]).toBe('ipfs://abc');
    const metadata = call.args[1] as ReadonlyArray<{ metadataKey: string }>;
    expect(metadata.length).toBe(2);
    expect(metadata[0]!.metadataKey).toBe('inft');
  });
});

describe('mintSubname', () => {
  it('uses publicMintSubname when publicMint=true', async () => {
    const { executor, spy } = makeExecutor([{ result: ('0x' + 'ab'.repeat(32)) as Hex, txHash: TX3 }]);
    const result = await mintSubname(executor, {
      ensRegistrar: ENS_REGISTRAR,
      label: 'researcher',
      owner: OWNER,
      publicMint: true,
    });
    expect(result.ok).toBe(true);
    const call = spy.mock.calls[0]![0] as { functionName: string; args: readonly unknown[] };
    expect(call.functionName).toBe('publicMintSubname');
    expect(call.args).toEqual(['researcher']);
  });

  it('uses owner-only mintSubname when publicMint=false', async () => {
    const { executor, spy } = makeExecutor([{ result: ('0x' + 'cd'.repeat(32)) as Hex, txHash: TX3 }]);
    await mintSubname(executor, {
      ensRegistrar: ENS_REGISTRAR,
      label: 'audit',
      owner: OWNER,
      publicMint: false,
    });
    const call = spy.mock.calls[0]![0] as { functionName: string; args: readonly unknown[] };
    expect(call.functionName).toBe('mintSubname');
    expect(call.args).toEqual(['audit', OWNER]);
  });

  it('returns Err ens on failure', async () => {
    const executor: MintExecutor = {
      call: async () => {
        throw new Error('label already claimed');
      },
    };
    const result = await mintSubname(executor, {
      ensRegistrar: ENS_REGISTRAR,
      label: 'taken',
      owner: OWNER,
      publicMint: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('ens');
    expect(result.error.reason).toBe('label already claimed');
  });
});

describe('grantSpendCap', () => {
  it('passes maxPerPeriod, periodLength, expiresAt verbatim', async () => {
    const { executor, spy } = makeExecutor([{ result: undefined, txHash: TX4 }]);
    const result = await grantSpendCap(executor, {
      spendCap: SPEND_CAP,
      account: OWNER,
      asset: USDC,
      maxPerPeriod: 50_000_000n,
      periodLength: 86_400n,
      expiresAt: 0n,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.txHash).toBe(TX4);

    const call = spy.mock.calls[0]![0] as { functionName: string; args: readonly unknown[] };
    expect(call.functionName).toBe('grant');
    expect(call.args).toEqual([OWNER, USDC, 50_000_000n, 86_400n, 0n]);
  });

  it('returns Err spend_cap on failure', async () => {
    const executor: MintExecutor = {
      call: async () => {
        throw new Error('caller is not authorized');
      },
    };
    const result = await grantSpendCap(executor, {
      spendCap: SPEND_CAP,
      account: OWNER,
      asset: USDC,
      maxPerPeriod: 1n,
      periodLength: 1n,
      expiresAt: 0n,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('spend_cap');
  });
});

describe('mint sequence (full flow)', () => {
  it('all 4 steps succeed in order', async () => {
    const { executor } = makeExecutor([
      { result: 1n, txHash: TX1 }, // mintAgentNFT
      { result: 1n, txHash: TX2 }, // registerAgent
      { result: ('0x' + '00'.repeat(32)) as Hex, txHash: TX3 }, // mintSubname
      { result: undefined, txHash: TX4 }, // grantSpendCap
    ]);

    const m = await mintAgentNFT(executor, {
      agentNft: AGENT_NFT, owner: OWNER, capabilityManifest: '0x',
    });
    const r = await registerAgent(executor, {
      agentRegistry: AGENT_REGISTRY, agentURI: 'ipfs://x', metadata: [],
    });
    const s = await mintSubname(executor, {
      ensRegistrar: ENS_REGISTRAR, label: 'x', owner: OWNER, publicMint: true,
    });
    const c = await grantSpendCap(executor, {
      spendCap: SPEND_CAP, account: OWNER, asset: USDC,
      maxPerPeriod: 50_000_000n, periodLength: 86_400n, expiresAt: 0n,
    });

    expect(m.ok).toBe(true);
    expect(r.ok).toBe(true);
    expect(s.ok).toBe(true);
    expect(c.ok).toBe(true);
  });
});
