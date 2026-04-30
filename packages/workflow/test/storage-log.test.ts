import { describe, it, expect, mock } from 'bun:test';
import {
  canonicalizeAuditPayload,
  writeAuditLog,
  type AuditLogPayload,
  type Storage0GClient,
} from '../src/storage-log.js';
import type { Hex } from 'viem';

const HEX_ROOT: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEX_TX: Hex = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const fixedPayload: AuditLogPayload = {
  version: '1',
  auditedAt: '2026-04-30T00:00:00Z',
  agentId: 42n,
  probe: { compliant: true, finding: 'baseline', tag: 'eu-aiact' },
  attestationRoot: '0xattest',
  paymentTxHash: '0xpay' as Hex,
  receiptTxHash: '0xrcpt' as Hex,
};

function mockClient(returnRoot = HEX_ROOT, returnTx = HEX_TX) {
  const upload = mock(async (_bytes: Uint8Array) => ({ rootHash: returnRoot, txHash: returnTx }));
  return { client: { upload } as Storage0GClient, spy: upload };
}

describe('canonicalizeAuditPayload', () => {
  it('produces stable bytes regardless of probe key insertion order', () => {
    const a = canonicalizeAuditPayload(fixedPayload);
    const b = canonicalizeAuditPayload({
      ...fixedPayload,
      probe: { tag: 'eu-aiact', finding: 'baseline', compliant: true }, // reversed order
    });
    expect(a).toBe(b);
  });

  it('encodes BigInt agentId as string', () => {
    const json = canonicalizeAuditPayload(fixedPayload);
    const parsed = JSON.parse(json) as { agentId: unknown };
    expect(parsed.agentId).toBe('42');
  });

  it('preserves null fields', () => {
    const json = canonicalizeAuditPayload({
      ...fixedPayload,
      attestationRoot: null,
      paymentTxHash: null,
      receiptTxHash: null,
    });
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.attestationRoot).toBeNull();
    expect(parsed.paymentTxHash).toBeNull();
    expect(parsed.receiptTxHash).toBeNull();
  });
});

describe('writeAuditLog', () => {
  it('returns Ok with rootHash, txHash, payloadHash on happy path', async () => {
    const { client, spy } = mockClient();
    const result = await writeAuditLog(client, fixedPayload);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.rootHash).toBe(HEX_ROOT);
    expect(result.value.txHash).toBe(HEX_TX);
    expect(result.value.payloadHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(spy).toHaveBeenCalledTimes(1);
    const callArg = spy.mock.calls[0]![0] as Uint8Array;
    expect(callArg).toBeInstanceOf(Uint8Array);
    expect(callArg.length).toBeGreaterThan(0);
  });

  it('upload bytes are deterministic across two calls', async () => {
    const { client: c1, spy: s1 } = mockClient();
    const { client: c2, spy: s2 } = mockClient();
    await writeAuditLog(c1, fixedPayload);
    await writeAuditLog(c2, fixedPayload);
    const bytes1 = s1.mock.calls[0]![0] as Uint8Array;
    const bytes2 = s2.mock.calls[0]![0] as Uint8Array;
    expect(bytes1).toEqual(bytes2);
  });

  it('returns Err upload_failed on transport error', async () => {
    const upload = mock(async () => {
      throw new Error('indexer 503 timeout');
    });
    const result = await writeAuditLog({ upload } as Storage0GClient, fixedPayload);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('upload_failed');
    expect(result.error.reason).toContain('503');
  });

  it('returns Err signer_rejected when error mentions insufficient funds', async () => {
    const upload = mock(async () => {
      throw new Error('insufficient funds for gas * price + value');
    });
    const result = await writeAuditLog({ upload } as Storage0GClient, fixedPayload);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('signer_rejected');
  });

  it('rejects empty auditedAt without calling upload', async () => {
    const { client, spy } = mockClient();
    const result = await writeAuditLog(client, { ...fixedPayload, auditedAt: '' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('malformed_payload');
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('returns canonical JSON when includeCanonical=true', async () => {
    const { client } = mockClient();
    const result = await writeAuditLog(client, fixedPayload, { includeCanonical: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(typeof result.value.canonical).toBe('string');
    const parsed = JSON.parse(result.value.canonical!) as { agentId: unknown };
    expect(parsed.agentId).toBe('42');
  });
});
