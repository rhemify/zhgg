import { describe, it, expect } from 'bun:test';
import {
  createInftAdapterFromContract,
  checkErc8004,
  type InftContractLike,
} from '../../src/identity/inft.js';

interface TxResponse {
  wait(): Promise<unknown>;
}

interface StubContractOptions {
  ownerOf?: (id: bigint) => Promise<string>;
  capabilities?: (id: bigint) => Promise<string>;
  memoryRoot?: (id: bigint) => Promise<string>;
  updateMemoryRoot?: (id: bigint, root: string) => Promise<TxResponse>;
  authorizeUsage?: (
    id: bigint,
    intentHash: string,
    overrides: { value: bigint },
  ) => Promise<TxResponse>;
}

const successTx = (): TxResponse => ({
  async wait() {
    return undefined;
  },
});

function makeContract(opts: StubContractOptions = {}): InftContractLike {
  return {
    ownerOf: opts.ownerOf ?? (async () => '0x' + '1'.repeat(40)),
    capabilities: opts.capabilities ?? (async () => '0x'),
    memoryRoot: opts.memoryRoot ?? (async () => '0x' + '0'.repeat(64)),
    updateMemoryRoot: opts.updateMemoryRoot ?? (async () => successTx()),
    authorizeUsage: opts.authorizeUsage ?? (async () => successTx()),
  };
}

function manifestHex(obj: Record<string, unknown>): string {
  return '0x' + Buffer.from(JSON.stringify(obj), 'utf8').toString('hex');
}

describe('inft adapter — readCapabilities', () => {
  it('parses JSON manifest into structured fields', async () => {
    const manifest = manifestHex({
      allowedModes: ['fast', 'verified'],
      maxCostUsd: 0.005,
      maxLatencyMs: 3000,
    });
    const adapter = createInftAdapterFromContract(
      makeContract({ capabilities: async () => manifest }),
    );
    const r = await adapter.readCapabilities('1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.allowedModes).toEqual(['fast', 'verified']);
      expect(r.value.maxCostUsd).toBe(0.005);
      expect(r.value.maxLatencyMs).toBe(3000);
    }
  });

  it('returns empty allowedModes when manifest is non-JSON', async () => {
    const adapter = createInftAdapterFromContract(
      makeContract({ capabilities: async () => '0xdeadbeef' }),
    );
    const r = await adapter.readCapabilities('1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.allowedModes).toEqual([]);
      expect(r.value.maxCostUsd).toBeNull();
    }
  });

  it('returns empty manifest when capabilities() returns empty bytes', async () => {
    const adapter = createInftAdapterFromContract(
      makeContract({ capabilities: async () => '0x' }),
    );
    const r = await adapter.readCapabilities('1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.allowedModes).toEqual([]);
  });

  it('caches result on second call', async () => {
    let calls = 0;
    const adapter = createInftAdapterFromContract(
      makeContract({
        capabilities: async () => {
          calls += 1;
          return manifestHex({ allowedModes: ['fast'] });
        },
      }),
    );
    await adapter.readCapabilities('5');
    await adapter.readCapabilities('5');
    expect(calls).toBe(1);
  });

  it('cache invalidates after updateMemoryRoot', async () => {
    let calls = 0;
    const adapter = createInftAdapterFromContract(
      makeContract({
        capabilities: async () => {
          calls += 1;
          return manifestHex({ allowedModes: ['fast'] });
        },
      }),
    );
    await adapter.readCapabilities('5');
    await adapter.updateMemoryRoot('5', '0x' + 'a'.repeat(64));
    await adapter.readCapabilities('5');
    expect(calls).toBe(2);
  });

  it('returns transport error when capabilities() throws', async () => {
    const adapter = createInftAdapterFromContract(
      makeContract({
        capabilities: async () => {
          throw new Error('rpc down');
        },
      }),
    );
    const r = await adapter.readCapabilities('1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('transport');
  });
});

describe('inft adapter — ownerOf', () => {
  it('returns owner address', async () => {
    const adapter = createInftAdapterFromContract(
      makeContract({ ownerOf: async () => '0xowner' }),
    );
    const r = await adapter.ownerOf('1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('0xowner');
  });

  it('returns transport error on revert', async () => {
    const adapter = createInftAdapterFromContract(
      makeContract({
        ownerOf: async () => {
          throw new Error('ERC721NonexistentToken');
        },
      }),
    );
    const r = await adapter.ownerOf('999');
    expect(r.ok).toBe(false);
  });
});

describe('inft adapter — updateMemoryRoot', () => {
  it('sends tx and returns the new root on success', async () => {
    let saw: { id: bigint; root: string } | null = null;
    const adapter = createInftAdapterFromContract(
      makeContract({
        updateMemoryRoot: async (id, root) => {
          saw = { id, root };
          return successTx();
        },
      }),
    );
    const root = '0x' + 'a'.repeat(64);
    const r = await adapter.updateMemoryRoot('7', root);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(root);
    expect(saw).not.toBeNull();
    expect(saw!.id).toBe(7n);
    expect(saw!.root).toBe(root);
  });

  it('classifies owner-related revert (string match) as unauthorized', async () => {
    const adapter = createInftAdapterFromContract(
      makeContract({
        updateMemoryRoot: async () => {
          throw new Error('AgentNFT: not token owner');
        },
      }),
    );
    const r = await adapter.updateMemoryRoot('1', '0x' + '0'.repeat(64));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('unauthorized');
  });

  it('classifies custom error (errorName=NotTokenOwner) as unauthorized', async () => {
    const adapter = createInftAdapterFromContract(
      makeContract({
        updateMemoryRoot: async () => {
          // ethers v5 sometimes attaches a decoded errorName on the thrown error.
          const err = Object.assign(new Error('execution reverted'), {
            errorName: 'NotTokenOwner',
          });
          throw err;
        },
      }),
    );
    const r = await adapter.updateMemoryRoot('1', '0x' + '0'.repeat(64));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('unauthorized');
  });

  it('classifies custom error data selector as unauthorized', async () => {
    const adapter = createInftAdapterFromContract(
      makeContract({
        updateMemoryRoot: async () => {
          const err = Object.assign(new Error('execution reverted (custom error)'), {
            data: '0x6d3d1858000000000000000000000000000000000000000000000000000000000000000a',
          });
          throw err;
        },
      }),
    );
    const r = await adapter.updateMemoryRoot('1', '0x' + '0'.repeat(64));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('unauthorized');
  });

  it('classifies generic revert as transport', async () => {
    const adapter = createInftAdapterFromContract(
      makeContract({
        updateMemoryRoot: async () => {
          throw new Error('network connection reset');
        },
      }),
    );
    const r = await adapter.updateMemoryRoot('1', '0x' + '0'.repeat(64));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('transport');
  });
});

describe('inft adapter — authorizeUsage', () => {
  it('forwards royaltyValue and returns the intent hash', async () => {
    let captured: { id: bigint; hash: string; value: bigint } | null = null;
    const adapter = createInftAdapterFromContract(
      makeContract({
        authorizeUsage: async (id, hash, overrides) => {
          captured = { id, hash, value: overrides.value };
          return successTx();
        },
      }),
    );
    const intentHash = '0x' + 'b'.repeat(64);
    const r = await adapter.authorizeUsage({
      tokenId: '3',
      intentHash,
      royaltyValue: 1234n,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(intentHash);
    expect(captured!.id).toBe(3n);
    expect(captured!.hash).toBe(intentHash);
    expect(captured!.value).toBe(1234n);
  });

  it('returns transport error on revert', async () => {
    const adapter = createInftAdapterFromContract(
      makeContract({
        authorizeUsage: async () => {
          throw new Error('refund failed');
        },
      }),
    );
    const r = await adapter.authorizeUsage({
      tokenId: '1',
      intentHash: '0x' + '0'.repeat(64),
      royaltyValue: 1n,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('transport');
  });
});

describe('inft adapter — invalidate', () => {
  it('clears all cached capabilities', async () => {
    let calls = 0;
    const adapter = createInftAdapterFromContract(
      makeContract({
        capabilities: async () => {
          calls += 1;
          return manifestHex({ allowedModes: ['fast'] });
        },
      }),
    );
    await adapter.readCapabilities('1');
    await adapter.readCapabilities('2');
    expect(calls).toBe(2);
    adapter.invalidate();
    await adapter.readCapabilities('1');
    await adapter.readCapabilities('2');
    expect(calls).toBe(4);
  });
});

describe('checkErc8004 — soft gate', () => {
  it('returns registered: false with informative reason', () => {
    const r = checkErc8004('0x' + '0'.repeat(40));
    expect(r.registered).toBe(false);
    expect(r.reason).toContain('soft-gate');
  });
});
