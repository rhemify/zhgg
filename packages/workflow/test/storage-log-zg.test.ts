import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Hex } from 'viem';
import { createZGStorageClient, type SdkOverride } from '../src/storage-log-zg.js';

const FAKE_ROOT = ('0x' + 'a'.repeat(64)) as Hex;
const FAKE_TX = ('0x' + 'b'.repeat(64)) as Hex;
const FAKE_KEY = '0x' + '1'.repeat(64);

function listZhggTmp(): string[] {
  return readdirSync(tmpdir()).filter((n) => n.startsWith('zhgg-zg-'));
}

interface MockTreeOk {
  rootHash: () => string;
}
type MerkleResult = [MockTreeOk | null, Error | null];

function buildMockSdk(opts: {
  uploadResult?: [{ hash: string } | null, Error | null];
  merkleResult?: MerkleResult;
  fromFilePathThrows?: Error;
}) {
  const closeSpy = mock(async () => {});
  const fromFilePathSpy = mock(async (path: string) => {
    if (opts.fromFilePathThrows) throw opts.fromFilePathThrows;
    return {
      __path: path,
      close: closeSpy,
      merkleTree: async (): Promise<MerkleResult> =>
        opts.merkleResult ?? [{ rootHash: () => FAKE_ROOT }, null],
    };
  });
  const uploadSpy = mock(async () => opts.uploadResult ?? [{ hash: FAKE_TX }, null]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  class FakeIndexer {
    constructor(public url: string) {}
    upload = uploadSpy;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  class FakeWallet {
    constructor(public key: string, public provider: unknown) {}
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  class FakeProvider {
    constructor(public url: string) {}
  }

  const sdk: SdkOverride = {
    Indexer: FakeIndexer as unknown as SdkOverride['Indexer'],
    ZgFile: { fromFilePath: fromFilePathSpy } as unknown as SdkOverride['ZgFile'],
    Wallet: FakeWallet as unknown as SdkOverride['Wallet'],
    JsonRpcProvider: FakeProvider as unknown as SdkOverride['JsonRpcProvider'],
  };
  return { sdk, fromFilePathSpy, uploadSpy, closeSpy };
}

describe('createZGStorageClient', () => {
  let baseline: Set<string>;
  beforeEach(() => {
    baseline = new Set(listZhggTmp());
  });
  afterEach(() => {
    // Any zhgg-zg-* dir created during the test must be removed by the
    // adapter itself — this enforces the cleanup contract.
    const leaked = listZhggTmp().filter((n) => !baseline.has(n));
    expect(leaked).toEqual([]);
  });

  it('writes bytes to a temp file, calls Indexer.upload, returns {rootHash, txHash}', async () => {
    const { sdk, fromFilePathSpy, uploadSpy } = buildMockSdk({});
    const client = createZGStorageClient({
      privateKey: FAKE_KEY,
      rpcUrl: 'http://rpc.test',
      indexerUrl: 'http://indexer.test',
      __sdkOverride: sdk,
    });
    const bytes = new TextEncoder().encode('{"hello":"world"}');
    const out = await client.upload(bytes);

    expect(out.rootHash).toBe(FAKE_ROOT);
    expect(out.txHash).toBe(FAKE_TX);
    expect(fromFilePathSpy).toHaveBeenCalledTimes(1);

    const path = fromFilePathSpy.mock.calls[0]![0] as string;
    expect(path.startsWith(tmpdir())).toBe(true);
    expect(path.endsWith('audit.json')).toBe(true);

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const args = uploadSpy.mock.calls[0]! as unknown as unknown[];
    expect(args[1]).toBe('http://rpc.test');
    expect(args[2]).toBeDefined();
  });

  it('cleans up temp dir even when upload returns Go-tuple error', async () => {
    const { sdk } = buildMockSdk({
      uploadResult: [null, new Error('indexer 503')],
    });
    const client = createZGStorageClient({ privateKey: FAKE_KEY, __sdkOverride: sdk });
    await expect(client.upload(new Uint8Array([1, 2, 3]))).rejects.toThrow(/indexer 503/);
  });

  it('cleans up temp dir even when merkleTree returns Go-tuple error', async () => {
    const { sdk } = buildMockSdk({
      merkleResult: [null, new Error('merkle bad chunk')],
    });
    const client = createZGStorageClient({ privateKey: FAKE_KEY, __sdkOverride: sdk });
    await expect(client.upload(new Uint8Array([9]))).rejects.toThrow(/merkle bad chunk/);
  });

  it('cleans up temp dir when ZgFile.fromFilePath throws', async () => {
    const { sdk } = buildMockSdk({ fromFilePathThrows: new Error('cannot open') });
    const client = createZGStorageClient({ privateKey: FAKE_KEY, __sdkOverride: sdk });
    await expect(client.upload(new Uint8Array([0]))).rejects.toThrow(/cannot open/);
  });

  it('rejects malformed rootHash from the SDK', async () => {
    const { sdk } = buildMockSdk({
      merkleResult: [{ rootHash: () => 'not-hex' }, null],
    });
    const client = createZGStorageClient({ privateKey: FAKE_KEY, __sdkOverride: sdk });
    await expect(client.upload(new Uint8Array([1]))).rejects.toThrow(/rootHash not 0x-hex/);
  });

  it('rejects when SDK returns a non-array (drift defense)', async () => {
    // Simulate an SDK upgrade that wraps the result in an object.
    const driftedSdk: SdkOverride = {
      Indexer: class {
        constructor(public url: string) {}
        upload = mock(async () => ({ wrapped: { hash: FAKE_TX } }));
      } as unknown as SdkOverride['Indexer'],
      ZgFile: {
        fromFilePath: mock(async () => ({
          close: mock(async () => {}),
          merkleTree: async () => [{ rootHash: () => FAKE_ROOT }, null],
        })),
      } as unknown as SdkOverride['ZgFile'],
      Wallet: class {
        constructor(public k: string, public p: unknown) {}
      } as unknown as SdkOverride['Wallet'],
      JsonRpcProvider: class {
        constructor(public u: string) {}
      } as unknown as SdkOverride['JsonRpcProvider'],
    };
    const client = createZGStorageClient({ privateKey: FAKE_KEY, __sdkOverride: driftedSdk });
    await expect(client.upload(new Uint8Array([1]))).rejects.toThrow(
      /upload expected Go tuple/
    );
  });

  it('rejects when SDK returns a 3-tuple (drift defense)', async () => {
    const driftedSdk: SdkOverride = {
      Indexer: class {
        constructor(public url: string) {}
        upload = mock(async () => [{ hash: FAKE_TX }, null, 'extra']);
      } as unknown as SdkOverride['Indexer'],
      ZgFile: {
        fromFilePath: mock(async () => ({
          close: mock(async () => {}),
          merkleTree: async () => [{ rootHash: () => FAKE_ROOT }, null],
        })),
      } as unknown as SdkOverride['ZgFile'],
      Wallet: class {
        constructor(public k: string, public p: unknown) {}
      } as unknown as SdkOverride['Wallet'],
      JsonRpcProvider: class {
        constructor(public u: string) {}
      } as unknown as SdkOverride['JsonRpcProvider'],
    };
    const client = createZGStorageClient({ privateKey: FAKE_KEY, __sdkOverride: driftedSdk });
    await expect(client.upload(new Uint8Array([1]))).rejects.toThrow(
      /upload expected 2-tuple, got length 3/
    );
  });
});
