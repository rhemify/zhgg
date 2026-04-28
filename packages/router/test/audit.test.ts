import { describe, it, expect } from 'bun:test';
import {
  createAuditWriter,
  hashContent,
  type AuditEnqueueInput,
  type AuditEvent,
  type AuditStorageBackend,
} from '../src/audit.js';

interface MockStorage extends AuditStorageBackend {
  uploads: AuditEvent[][];
  rootHashes: string[];
  failNext: (reason: string) => void;
}

function mockStorage(opts: { rootHash?: string } = {}): MockStorage {
  const uploads: AuditEvent[][] = [];
  const rootHashes: string[] = [];
  let pendingFailure: string | null = null;
  let counter = 0;
  return {
    uploads,
    rootHashes,
    failNext(reason) {
      pendingFailure = reason;
    },
    async upload(events) {
      if (pendingFailure !== null) {
        const r = pendingFailure;
        pendingFailure = null;
        throw new Error(r);
      }
      uploads.push([...events]);
      const root =
        opts.rootHash ?? `0xroot-${counter++}-${events.length}`;
      rootHashes.push(root);
      return root;
    },
  };
}

const baseInput: AuditEnqueueInput = {
  agent_inft: 'inft-1',
  mode: 'fast',
  providers: ['p1'],
  prompt: 'what is the price of ETH?',
  response: '3000 USD',
  cost_usd: 0.001,
  latency_ms: 120,
  agreement_score: null,
  attestation_root: null,
  keeperhub_txs: [],
  low_confidence: false,
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('audit.hashContent', () => {
  it('returns 0x-prefixed 64-hex SHA-256 digest', () => {
    const h = hashContent('hello');
    expect(h.startsWith('0x')).toBe(true);
    expect(h.length).toBe(2 + 64);
    expect(/^0x[0-9a-f]{64}$/.test(h)).toBe(true);
  });

  it('is deterministic', () => {
    expect(hashContent('abc')).toBe(hashContent('abc'));
  });

  it('produces different hashes for different inputs', () => {
    expect(hashContent('a')).not.toBe(hashContent('b'));
  });
});

describe('audit.enqueue', () => {
  it('returns void synchronously (no await needed)', () => {
    const w = createAuditWriter({ storage: mockStorage() });
    const r = w.enqueue(baseInput);
    expect(r).toBeUndefined();
    expect(w.pending()).toBe(1);
  });

  it('hashes prompt and response — never stores raw text', async () => {
    const storage = mockStorage();
    const w = createAuditWriter({ storage });
    w.enqueue(baseInput);
    const flushed = await w.flush();
    expect(flushed.ok).toBe(true);
    const event = storage.uploads[0]?.[0];
    expect(event).toBeDefined();
    if (!event) return;
    expect(event.prompt_hash).toBe(hashContent(baseInput.prompt));
    expect(event.response_hash).toBe(hashContent(baseInput.response));
    // Crucially: raw fields must not appear on the event
    expect((event as unknown as Record<string, unknown>).prompt).toBeUndefined();
    expect((event as unknown as Record<string, unknown>).response).toBeUndefined();
    // Sanity check: hashes are hex, not the raw plaintext
    expect(event.prompt_hash).not.toBe(baseInput.prompt);
    expect(event.response_hash).not.toBe(baseInput.response);
  });

  it('AuditEvent has all required fields with correct shape', async () => {
    const storage = mockStorage();
    const w = createAuditWriter({ storage });
    w.enqueue({
      ...baseInput,
      mode: 'consensus',
      providers: ['p1', 'p2', 'p3'],
      agreement_score: 0.92,
      attestation_root: '0xattest',
      keeperhub_txs: ['0xtx1'],
      low_confidence: false,
    });
    await w.flush();
    const e = storage.uploads[0]?.[0];
    expect(e).toBeDefined();
    if (!e) return;
    expect(typeof e.ts).toBe('number');
    expect(e.ts).toBeGreaterThan(0);
    expect(e.agent_inft).toBe('inft-1');
    expect(e.mode).toBe('consensus');
    expect(e.providers).toEqual(['p1', 'p2', 'p3']);
    expect(typeof e.prompt_hash).toBe('string');
    expect(typeof e.response_hash).toBe('string');
    expect(e.cost_usd).toBe(0.001);
    expect(e.latency_ms).toBe(120);
    expect(e.agreement_score).toBe(0.92);
    expect(e.attestation_root).toBe('0xattest');
    expect(e.keeperhub_txs).toEqual(['0xtx1']);
    expect(e.low_confidence).toBe(false);
  });

  it('prompt_hash and response_hash are 64-hex chars with 0x prefix', async () => {
    const storage = mockStorage();
    const w = createAuditWriter({ storage });
    w.enqueue(baseInput);
    await w.flush();
    const e = storage.uploads[0]?.[0];
    expect(e).toBeDefined();
    if (!e) return;
    expect(/^0x[0-9a-f]{64}$/.test(e.prompt_hash)).toBe(true);
    expect(/^0x[0-9a-f]{64}$/.test(e.response_hash)).toBe(true);
  });

  it('does NOT mutate caller-provided arrays (defensive copy)', async () => {
    const storage = mockStorage();
    const w = createAuditWriter({ storage });
    const providers = ['p1'];
    const txs = ['0xtx1'];
    w.enqueue({ ...baseInput, providers, keeperhub_txs: txs });
    providers.push('p2');
    txs.push('0xtx2');
    await w.flush();
    const e = storage.uploads[0]?.[0];
    expect(e?.providers).toEqual(['p1']);
    expect(e?.keeperhub_txs).toEqual(['0xtx1']);
  });
});

describe('audit.flush', () => {
  it('with empty queue returns Result.ok(null)', async () => {
    const storage = mockStorage();
    const w = createAuditWriter({ storage });
    const r = await w.flush();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
    expect(storage.uploads).toHaveLength(0);
  });

  it('calls storage.upload exactly once with all queued events', async () => {
    const storage = mockStorage();
    const w = createAuditWriter({ storage });
    w.enqueue(baseInput);
    w.enqueue(baseInput);
    w.enqueue(baseInput);
    await w.flush();
    expect(storage.uploads).toHaveLength(1);
    expect(storage.uploads[0]).toHaveLength(3);
  });

  it('returns the rootHash as Result.ok(rootHash)', async () => {
    const storage = mockStorage({ rootHash: '0xdeadbeef' });
    const w = createAuditWriter({ storage });
    w.enqueue(baseInput);
    const r = await w.flush();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('0xdeadbeef');
  });

  it('with failing upload returns Result.error AND preserves queue for retry', async () => {
    const storage = mockStorage();
    const w = createAuditWriter({ storage });
    w.enqueue(baseInput);
    w.enqueue(baseInput);
    storage.failNext('indexer down');
    const r = await w.flush();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('upload_failed');
      expect(r.error.reason).toContain('indexer down');
    }
    expect(w.pending()).toBe(2);
    // Retry succeeds
    const r2 = await w.flush();
    expect(r2.ok).toBe(true);
    expect(w.pending()).toBe(0);
    expect(storage.uploads).toHaveLength(1);
    expect(storage.uploads[0]).toHaveLength(2);
  });

  it('multiple enqueue calls between flushes batch into a single upload', async () => {
    const storage = mockStorage();
    const w = createAuditWriter({ storage });
    for (let i = 0; i < 5; i++) w.enqueue(baseInput);
    expect(w.pending()).toBe(5);
    await w.flush();
    expect(storage.uploads).toHaveLength(1);
    expect(storage.uploads[0]).toHaveLength(5);
    // Next flush with no new events returns null
    const r = await w.flush();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it('preserves FIFO order across failed-then-retry flush', async () => {
    const storage = mockStorage();
    const w = createAuditWriter({ storage });
    w.enqueue({ ...baseInput, prompt: 'one' });
    w.enqueue({ ...baseInput, prompt: 'two' });
    storage.failNext('oops');
    await w.flush();
    // New event arrives during the "outage"
    w.enqueue({ ...baseInput, prompt: 'three' });
    expect(w.pending()).toBe(3);
    await w.flush();
    expect(storage.uploads).toHaveLength(1);
    const batch = storage.uploads[0]!;
    expect(batch[0]?.prompt_hash).toBe(hashContent('one'));
    expect(batch[1]?.prompt_hash).toBe(hashContent('two'));
    expect(batch[2]?.prompt_hash).toBe(hashContent('three'));
  });
});

describe('audit single-flight flush gate', () => {
  it('concurrent flush() calls share the same in-flight upload', async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => {
      resolve = r;
    });
    let uploads = 0;
    const slowStorage = {
      async upload() {
        uploads += 1;
        await gate;
        return '0xroot-slow';
      },
    };
    const w = createAuditWriter({ storage: slowStorage, flushIntervalMs: 100_000 });
    w.enqueue(baseInput);
    const a = w.flush();
    const b = w.flush();
    resolve();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    // Single upload — concurrent flush() short-circuited via in-flight promise.
    expect(uploads).toBe(1);
  });
});

describe('audit background flush', () => {
  it('fires after flushIntervalMs', async () => {
    const storage = mockStorage();
    const w = createAuditWriter({ storage, flushIntervalMs: 50 });
    w.enqueue(baseInput);
    expect(w.pending()).toBe(1);
    await wait(120);
    expect(storage.uploads.length).toBeGreaterThanOrEqual(1);
    expect(w.pending()).toBe(0);
    await w.close();
  });
});

describe('audit onFlushed callback', () => {
  it('fires with the rootHash after successful flush', async () => {
    const storage = mockStorage({ rootHash: '0xroot-A' });
    const w = createAuditWriter({ storage });
    const received: { value: string | null } = { value: null };
    w.enqueue({
      ...baseInput,
      onFlushed: (cid) => {
        received.value = cid;
      },
    });
    await w.flush();
    expect(received.value).toBe('0xroot-A');
  });

  it('does NOT fire on failed flush', async () => {
    const storage = mockStorage();
    const w = createAuditWriter({ storage });
    let fired = false;
    w.enqueue({
      ...baseInput,
      onFlushed: () => {
        fired = true;
      },
    });
    storage.failNext('boom');
    const r = await w.flush();
    expect(r.ok).toBe(false);
    expect(fired).toBe(false);
    // Retry success: callback should now fire (event was preserved in queue)
    const r2 = await w.flush();
    expect(r2.ok).toBe(true);
    expect(fired).toBe(true);
  });

  it('callback errors do not poison the writer', async () => {
    const storage = mockStorage();
    const w = createAuditWriter({ storage });
    w.enqueue({
      ...baseInput,
      onFlushed: () => {
        throw new Error('user code threw');
      },
    });
    const r = await w.flush();
    expect(r.ok).toBe(true);
  });
});

describe('audit back-pressure', () => {
  it('drops oldest when maxQueueSize exceeded — newest survive', async () => {
    const storage = mockStorage();
    const w = createAuditWriter({ storage, maxQueueSize: 3 });
    // Use distinct prompts so we can identify which survived
    for (let i = 0; i < 5; i++) {
      w.enqueue({ ...baseInput, prompt: `prompt-${i}` });
    }
    expect(w.pending()).toBe(3);
    await w.flush();
    const batch = storage.uploads[0]!;
    expect(batch).toHaveLength(3);
    // Should contain prompts 2, 3, 4 (oldest 0 and 1 dropped)
    expect(batch[0]?.prompt_hash).toBe(hashContent('prompt-2'));
    expect(batch[1]?.prompt_hash).toBe(hashContent('prompt-3'));
    expect(batch[2]?.prompt_hash).toBe(hashContent('prompt-4'));
  });
});

describe('audit lifecycle', () => {
  it('close() runs final flush and clears interval', async () => {
    const storage = mockStorage();
    const w = createAuditWriter({ storage, flushIntervalMs: 50 });
    w.enqueue(baseInput);
    await w.close();
    expect(storage.uploads).toHaveLength(1);
    expect(w.pending()).toBe(0);
    // After close, further enqueues are dropped
    w.enqueue(baseInput);
    expect(w.pending()).toBe(0);
    // Wait past the would-be interval; no further uploads should occur
    const before = storage.uploads.length;
    await wait(120);
    expect(storage.uploads.length).toBe(before);
  });

  it('pending() reports correct buffered count', () => {
    const storage = mockStorage();
    const w = createAuditWriter({ storage });
    expect(w.pending()).toBe(0);
    w.enqueue(baseInput);
    expect(w.pending()).toBe(1);
    w.enqueue(baseInput);
    w.enqueue(baseInput);
    expect(w.pending()).toBe(3);
  });
});
