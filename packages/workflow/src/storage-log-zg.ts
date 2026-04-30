/// SDK-backed default `Storage0GClient` — wraps `@0gfoundation/0g-ts-sdk`'s
/// `Indexer.upload` against ethers v6. This is the ONLY module in the
/// workflow package that touches ethers or the 0G SDK; the rest of the
/// package (storage-log.ts, erc8004.ts, x402.ts) stays viem-pure.
///
/// Wiring is opt-in. `storage-log.ts` does NOT import this file. Live
/// callers explicitly `import { createZGStorageClient } from '@zhgg/workflow/storage-log-zg'`
/// and pass the returned `Storage0GClient` into `writeAuditLog`. Tests
/// inject `__sdkOverride` to bypass the real SDK.
///
/// Why dynamic imports: the workflow package compiles cleanly without
/// `ethers` or `@0gfoundation/0g-ts-sdk` installed. Live demos add those
/// peers; CI / mocked-mode runs don't. Failure to load is surfaced as a
/// thrown Error from `upload()` rather than at module-import time.
///
/// Why temp files (not Uint8Array): `ZgFile` only exposes
/// `fromFilePath(path)` server-side. The Node Merkle path mmaps and
/// streams the file by chunk. We pay one fs round-trip per audit log
/// (~1 KB JSON), which is negligible vs. the storage-node submission.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hex } from 'viem';
import type { Storage0GClient } from './storage-log.js';

/// Galileo defaults — mirror docs/0g.md so a missing override does not
/// silently target a different network.
const GALILEO_EVM_RPC_DEFAULT = 'https://evmrpc-testnet.0g.ai';
const GALILEO_INDEXER_RPC_DEFAULT = 'https://indexer-storage-testnet-turbo.0g.ai';

export interface ZGStorageClientOptions {
  /// 0G Galileo signer key. 64-hex (no 0x), or 0x-prefixed 66-char.
  /// Caller is responsible for keeping the wallet funded.
  privateKey: string;
  /// EVM RPC for Galileo. Defaults to the public testnet RPC.
  rpcUrl?: string;
  /// Storage indexer RPC. Defaults to the Turbo indexer.
  indexerUrl?: string;
  /// Test seam — when set, replaces the real SDK + ethers loads. Not
  /// part of the public production surface.
  __sdkOverride?: SdkOverride;
}

/// Test seam for unit tests. Production code never sets this.
export interface SdkOverride {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Indexer: new (url: string) => { upload: (...args: unknown[]) => Promise<unknown> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ZgFile: { fromFilePath: (path: string) => Promise<any> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Wallet: new (key: string, provider: unknown) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  JsonRpcProvider: new (url: string) => any;
}

/// Build a production `Storage0GClient` backed by the 0G TS SDK. Caller
/// is responsible for wallet lifecycle. The first `upload()` call
/// dynamically loads ethers + the 0G SDK; if the deps aren't installed
/// this surfaces as an Error from `upload`, not at construction time.
export function createZGStorageClient(opts: ZGStorageClientOptions): Storage0GClient {
  const rpcUrl = opts.rpcUrl ?? GALILEO_EVM_RPC_DEFAULT;
  const indexerUrl = opts.indexerUrl ?? GALILEO_INDEXER_RPC_DEFAULT;
  const privateKey = normalizeKey(opts.privateKey);

  return {
    async upload(bytes: Uint8Array): Promise<{ rootHash: Hex; txHash: Hex }> {
      const sdk = opts.__sdkOverride ?? (await loadSdk());

      const provider = new sdk.JsonRpcProvider(rpcUrl);
      const signer = new sdk.Wallet(privateKey, provider);
      const indexer = new sdk.Indexer(indexerUrl);

      // Node ZgFile path requires a real filesystem path. Audit payloads
      // are tiny (~1 KB) and a temp dir per call avoids any collision
      // risk between concurrent audits.
      const dir = mkdtempSync(join(tmpdir(), 'zhgg-zg-'));
      const filePath = join(dir, 'audit.json');
      let zgFile: { close: () => Promise<void> } | null = null;
      try {
        writeFileSync(filePath, bytes);

        zgFile = (await sdk.ZgFile.fromFilePath(filePath)) as {
          close: () => Promise<void>;
          merkleTree: () => Promise<[{ rootHash: () => string } | null, Error | null]>;
        };

        // SDK returns Go-style `[value, err]` tuples; never throws on
        // indexer-side failures. Forward both legs as Error throws.
        const merkle = (zgFile as unknown as {
          merkleTree: () => Promise<[{ rootHash: () => string } | null, Error | null]>;
        }).merkleTree();
        const [tree, treeErr] = await merkle;
        if (treeErr !== null || tree === null) {
          throw new Error(`merkleTree failed: ${errMsg(treeErr)}`);
        }
        const rootHash = ensureHex(tree.rootHash(), 'rootHash');

        const uploadResult = (await indexer.upload(zgFile, rpcUrl, signer)) as [
          { hash: string } | null,
          Error | null,
        ];
        const [tx, uploadErr] = uploadResult;
        if (uploadErr !== null || tx === null) {
          throw new Error(`upload failed: ${errMsg(uploadErr)}`);
        }
        const txHash = ensureHex(tx.hash, 'txHash');

        return { rootHash, txHash };
      } finally {
        if (zgFile) {
          try {
            await zgFile.close();
          } catch {
            // Closing a half-opened ZgFile can throw; we already have a
            // higher-priority error in flight or are on the success path
            // where the leak is bounded by the temp-dir removal below.
          }
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

async function loadSdk(): Promise<SdkOverride> {
  // Dynamic imports keep the workflow package buildable without these
  // peers installed. Live mode adds them; mocked tests use __sdkOverride.
  const ethersMod = (await import(/* @vite-ignore */ 'ethers' as string)) as {
    ethers: { JsonRpcProvider: SdkOverride['JsonRpcProvider']; Wallet: SdkOverride['Wallet'] };
  };
  const zgMod = (await import(/* @vite-ignore */ '@0gfoundation/0g-ts-sdk' as string)) as {
    Indexer: SdkOverride['Indexer'];
    ZgFile: SdkOverride['ZgFile'];
  };
  return {
    Indexer: zgMod.Indexer,
    ZgFile: zgMod.ZgFile,
    Wallet: ethersMod.ethers.Wallet,
    JsonRpcProvider: ethersMod.ethers.JsonRpcProvider,
  };
}

function normalizeKey(k: string): string {
  return k.startsWith('0x') ? k : `0x${k}`;
}

function ensureHex(v: string, label: string): Hex {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) {
    throw new Error(`${label} not 0x-hex: ${String(v)}`);
  }
  return v as Hex;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e === null || e === undefined) return 'unknown';
  return String(e);
}
