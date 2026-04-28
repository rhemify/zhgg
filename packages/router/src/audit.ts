/**
 * Async append-only audit writer that pins inference events to 0G Storage.
 *
 * Boundary contract (per docs/SPEC.md "Always-Active Infrastructure"):
 *   - We NEVER persist raw prompts or raw responses. Both are keccak256 hashed
 *     at enqueue() time, before they ever enter the in-memory queue. keccak256
 *     is the EVM-native digest so AgentNFT.sol's audit verifier can recompute
 *     `keccak256(plaintext) === event.prompt_hash` on-chain.
 *   - enqueue() returns synchronously. Callers do not block on storage commit.
 *   - A background timer flushes the queue every flushIntervalMs (default 5s).
 *   - On flush, the events array is JSON-encoded, wrapped in MemData, and
 *     uploaded via the 0G Storage Indexer. The returned rootHash IS the
 *     audit_cid the router stamps onto its RouteResult.
 *
 * Failure model:
 *   - If upload throws, the snapshot is restored to the FRONT of the queue and
 *     the error surfaces via flush()'s Result. Callers (or the next tick) get
 *     to retry. Background-timer failures are swallowed via console.warn so a
 *     transient indexer outage cannot crash the router.
 *   - If the queue exceeds maxQueueSize, OLDEST events are dropped (FIFO trim)
 *     and a warning is logged. Under sustained back-pressure we prefer fresh
 *     events over a stale tail.
 */

import { utils as ethersUtils } from 'ethers';
import type { Mode } from './intent.js';
import type { Result } from './result.js';
import { loadEnv, requireZgKey } from './constants.js';

export interface AuditEvent {
  ts: number;
  agent_inft: string;
  mode: Mode;
  providers: string[];
  prompt_hash: string;
  response_hash: string;
  cost_usd: number;
  latency_ms: number;
  agreement_score: number | null;
  attestation_root: string | null;
  keeperhub_txs: string[];
  low_confidence: boolean;
}

export interface AuditEnqueueInput {
  agent_inft: string;
  mode: Mode;
  providers: string[];
  /** Raw prompt — hashed to prompt_hash before queueing. NEVER stored. */
  prompt: string;
  /** Raw response — hashed to response_hash before queueing. NEVER stored. */
  response: string;
  cost_usd: number;
  latency_ms: number;
  agreement_score: number | null;
  attestation_root: string | null;
  keeperhub_txs: string[];
  low_confidence: boolean;
  /** Optional callback fired once this batch flushes. Receives the audit_cid. */
  onFlushed?: (cid: string) => void;
}

export type AuditError =
  | { kind: 'storage_unavailable'; reason: string }
  | { kind: 'upload_failed'; reason: string };

export interface AuditWriter {
  /** Returns immediately. Caller does NOT block on storage commit. */
  enqueue(input: AuditEnqueueInput): void;
  /** Force-flush queue. Returns the new root hash, or null if queue was empty. */
  flush(): Promise<Result<string | null, AuditError>>;
  /** Stop background timer and run final flush. */
  close(): Promise<void>;
  /** Diagnostic: how many events are currently buffered. */
  pending(): number;
}

export interface AuditStorageBackend {
  /** Returns rootHash of the uploaded blob, or throws. */
  upload(events: readonly AuditEvent[]): Promise<string>;
}

export interface AuditOptions {
  flushIntervalMs?: number;
  maxQueueSize?: number;
  storage?: AuditStorageBackend;
}

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_QUEUE_SIZE = 1_000;
const DEFAULT_INDEXER_URL = 'https://indexer-storage-testnet-turbo.0g.ai';

/**
 * Hash a UTF-8 string with keccak256 and return a 0x-prefixed 64-hex digest.
 * keccak256 is the EVM-native digest, matching what AgentNFT.sol's audit
 * verifier (Phase 4) will compute on-chain when checking
 * `keccak256(plaintext) === event.prompt_hash`.
 */
export function hashContent(input: string): string {
  return ethersUtils.keccak256(ethersUtils.toUtf8Bytes(input));
}

interface QueueSlot {
  event: AuditEvent;
  onFlushed?: (cid: string) => void;
}

/**
 * Default no-op storage backend. Used when no storage is configured so that
 * enqueue() never throws on cold-start. flush() with this backend always
 * succeeds and returns a deterministic stub rootHash so downstream consumers
 * can treat the audit as "best-effort" until a real backend is wired.
 */
function createNoopStorage(): AuditStorageBackend {
  return {
    async upload(events) {
      const json = JSON.stringify(events);
      return hashContent(json);
    },
  };
}

export function createAuditWriter(opts: AuditOptions = {}): AuditWriter {
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxQueueSize = opts.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  const storage = opts.storage ?? createNoopStorage();

  let queue: QueueSlot[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  // Single-flight gate. Prevents the background timer from racing with an
  // explicit flush() while a previous upload is still in flight.
  let flushing: Promise<Result<string | null, AuditError>> | null = null;

  function ensureTimer(): void {
    if (timer !== null || closed) return;
    timer = setInterval(() => {
      // Background flushes swallow errors so a transient outage cannot crash
      // the host process via an unhandled rejection.
      void doFlush().then((r) => {
        if (!r.ok) {
          console.warn(
            `[audit] background flush failed: ${r.error.kind}: ${r.error.reason}`,
          );
        }
      });
    }, flushIntervalMs);
    // Don't keep the event loop alive solely for the audit flush timer.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref?: () => void }).unref?.();
    }
  }

  async function doFlush(): Promise<Result<string | null, AuditError>> {
    if (flushing) return flushing;

    const snapshot = queue;
    if (snapshot.length === 0) {
      return { ok: true, value: null };
    }
    queue = [];

    const events = snapshot.map((s) => s.event);
    const promise = (async (): Promise<Result<string | null, AuditError>> => {
      try {
        const rootHash = await storage.upload(events);
        // Fire callbacks AFTER we know the upload succeeded. Callback errors
        // must not poison the writer.
        for (const slot of snapshot) {
          if (slot.onFlushed) {
            try {
              slot.onFlushed(rootHash);
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              console.warn(`[audit] onFlushed callback threw: ${reason}`);
            }
          }
        }
        return { ok: true, value: rootHash };
      } catch (err) {
        // Restore the snapshot to the FRONT of the queue so retry preserves
        // FIFO order even if new events arrived during the failed upload.
        queue = [...snapshot, ...queue];
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { kind: 'upload_failed', reason } };
      }
    })();

    flushing = promise;
    try {
      return await promise;
    } finally {
      flushing = null;
    }
  }

  return {
    enqueue(input: AuditEnqueueInput): void {
      if (closed) {
        // Silently drop after close() — the writer is no longer alive.
        return;
      }

      const event: AuditEvent = {
        ts: Date.now(),
        agent_inft: input.agent_inft,
        mode: input.mode,
        providers: [...input.providers],
        prompt_hash: hashContent(input.prompt),
        response_hash: hashContent(input.response),
        cost_usd: input.cost_usd,
        latency_ms: input.latency_ms,
        agreement_score: input.agreement_score,
        attestation_root: input.attestation_root,
        keeperhub_txs: [...input.keeperhub_txs],
        low_confidence: input.low_confidence,
      };

      queue.push({ event, onFlushed: input.onFlushed });

      // Back-pressure: drop OLDEST entries past the cap. Fresh events win.
      if (queue.length > maxQueueSize) {
        const dropped = queue.length - maxQueueSize;
        queue.splice(0, dropped);
        console.warn(
          `[audit] queue exceeded ${maxQueueSize}; dropped ${dropped} oldest event(s)`,
        );
      }

      ensureTimer();
    },

    async flush(): Promise<Result<string | null, AuditError>> {
      return doFlush();
    },

    async close(): Promise<void> {
      closed = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      // Final flush: surface failure via console.warn since close() returns
      // void — callers expect a fire-and-forget shutdown.
      const r = await doFlush();
      if (!r.ok) {
        console.warn(
          `[audit] final flush on close failed: ${r.error.kind}: ${r.error.reason}`,
        );
      }
    },

    pending(): number {
      return queue.length;
    },
  };
}

// ---------------------------------------------------------------------------
// 0G Storage backend (production)
// ---------------------------------------------------------------------------

export interface ZgStorageOptions {
  indexerUrl?: string;
  rpcUrl?: string;
  privateKey?: string;
}

/**
 * Production AuditStorageBackend wired to 0G Storage via Indexer + MemData.
 * SDK imports are lazy so test paths and cold imports don't pull ethers v5.
 */
export function createZgStorageBackend(
  opts: ZgStorageOptions = {},
): AuditStorageBackend {
  const env = loadEnv();
  const indexerUrl = opts.indexerUrl ?? DEFAULT_INDEXER_URL;
  const rpcUrl = opts.rpcUrl ?? env.ZG_RPC_URL;
  const privateKey = opts.privateKey ?? requireZgKey(env);

  return {
    async upload(events: readonly AuditEvent[]): Promise<string> {
      let SdkMod: typeof import('@0glabs/0g-ts-sdk');
      let EthersMod: typeof import('ethers');
      try {
        SdkMod = await import('@0glabs/0g-ts-sdk');
        EthersMod = await import('ethers');
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`storage_unavailable: failed to load 0G SDK: ${reason}`);
      }

      const { Indexer, MemData } = SdkMod;
      // ethers v5 surface — JsonRpcProvider lives under providers, Wallet at root.
      const ethersAny = EthersMod as unknown as {
        providers: { JsonRpcProvider: new (url: string) => unknown };
        Wallet: new (key: string, provider: unknown) => unknown;
      };
      const provider = new ethersAny.providers.JsonRpcProvider(rpcUrl);
      const wallet = new ethersAny.Wallet(privateKey, provider);

      const json = JSON.stringify(events);
      // MemData expects ArrayLike<number>. Spreading the Buffer guarantees a
      // plain number[] regardless of Buffer's runtime quirks.
      const bytes = [...Buffer.from(json, 'utf8')];
      const file = new MemData(bytes);

      const indexer = new Indexer(indexerUrl);
      const tuple = (await (
        indexer as unknown as {
          upload: (
            f: unknown,
            rpc: string,
            signer: unknown,
          ) => Promise<[{ txHash?: string; rootHash: string } | null, Error | null]>;
        }
      ).upload(file, rpcUrl, wallet));
      const [result, err] = tuple;
      if (err !== null) {
        throw err;
      }
      if (result === null || typeof result.rootHash !== 'string') {
        throw new Error('0G upload returned no rootHash');
      }
      return result.rootHash;
    },
  };
}
