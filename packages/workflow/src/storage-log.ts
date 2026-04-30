/// 0G Storage Log writer — Step 8 of the always-active audit loop.
///
/// After every successful audit (probe → attestation → payment receipt),
/// the workflow canonicalizes the audit JSON, hashes it, and uploads it
/// to 0G Storage's append-only Log layer via the injected
/// `Storage0GClient`. The returned `rootHash` is what Step 9 pins to the
/// iNFT's `memoryRoot`; the returned `txHash` is the on-chain Flow-
/// contract anchor that proves the bytes existed at a Galileo block
/// height.
///
/// This module is deliberately viem-pure and SDK-free: callers inject a
/// `Storage0GClient` adapter so the same logic runs against the live
/// 0g-ts-sdk in production and against a mock in tests. The default
/// SDK-backed client lives in `./storage-log-zg.ts` (separate module —
/// it's the only place ethers + @0glabs/0g-ts-sdk cross into the
/// workflow package).
///
/// JSON canonicalization mirrors `buildFeedbackJson` in `./erc8004.ts`:
/// stable key order, BigInts encoded as strings, no whitespace. Off-chain
/// verifiers in JS / Rust / Go reproduce the same bytes byte-for-byte.

import { keccak256, toBytes, type Hex } from 'viem';
import type { Result } from './adapters/zg-router.js';

/// Audit payload written to 0G Storage Log. Structured rather than
/// `unknown` so adding a field forces an explicit update to
/// `canonicalizeAuditPayload` — guards against silent encoding drift.
export interface AuditLogPayload {
  /// Schema version. Bump when the canonical encoding changes — old
  /// rootHashes stay valid; new ones use the new layout.
  version: '1';
  /// ISO-8601 UTC, e.g. "2026-04-29T14:32:11.482Z". Set ONCE at audit
  /// start (not at log-write time) so the canonical bytes are stable.
  auditedAt: string;
  /// ERC-7857 token ID of the iNFT whose memory this audit updates.
  agentId: bigint;
  /// Probe results — opaque JSON-serializable record. The probe layer
  /// owns the schema; we just promise stable key order on serialize.
  probe: Record<string, unknown>;
  /// TEE attestation root from 0G Compute (`x-tee-attestation` header).
  /// Null when inference ran outside a TEE (e.g. local dev).
  attestationRoot: string | null;
  /// x402 payment receipt — on-chain tx hash of the user's payment.
  paymentTxHash: Hex | null;
  /// ERC-8004 feedback receipt tx hash from `postReceipt`. Null when
  /// the audit ran in dry-run / test mode.
  receiptTxHash: Hex | null;
}

/// Adapter interface for the 0G Storage upload. Production impl wraps
/// `@0glabs/0g-ts-sdk`'s `Indexer.upload`; tests inject a mock that
/// returns `{rootHash, txHash}` without touching network. Mirrors the
/// `Erc8004Client` pattern in `./erc8004.ts`.
export interface Storage0GClient {
  /// Upload UTF-8 bytes to the 0G Storage Log layer. Returns the local
  /// Merkle root (computed deterministically from `bytes`) and the
  /// Flow-contract anchor tx hash (from the Galileo on-chain submission).
  upload(bytes: Uint8Array): Promise<{ rootHash: Hex; txHash: Hex }>;
}

export type StorageError =
  | { kind: 'malformed_payload'; reason: string }
  | { kind: 'upload_failed'; reason: string }
  | { kind: 'signer_rejected'; reason: string };

export interface WriteAuditLogOptions {
  /// When true, also return the canonical JSON string. Default: false.
  includeCanonical?: boolean;
}

export interface WriteAuditLogSuccess {
  rootHash: Hex;
  txHash: Hex;
  /// keccak256 of the canonical UTF-8 bytes. Returned unconditionally
  /// because the rootHash is a 0G Merkle root (different algorithm) and
  /// callers often need the keccak hash for ERC-8004 cross-referencing.
  payloadHash: Hex;
  /// Only present when `includeCanonical` is true.
  canonical?: string;
}

/// Build the canonical UTF-8 bytes for an audit payload. Stable key
/// order, BigInts as strings, no whitespace. Mirrors
/// `buildFeedbackJson` in `./erc8004.ts` so off-chain verifiers in
/// other languages reproduce the same bytes byte-for-byte.
export function canonicalizeAuditPayload(p: AuditLogPayload): string {
  const stable: Record<string, unknown> = {
    type: 'https://zhgg.eth/schemas/audit-log-v1',
    version: p.version,
    auditedAt: p.auditedAt,
    agentId: p.agentId.toString(),
    probe: JSON.parse(stableStringify(p.probe)),
    attestationRoot: p.attestationRoot,
    paymentTxHash: p.paymentTxHash,
    receiptTxHash: p.receiptTxHash,
  };
  return JSON.stringify(stable);
}

/// Recursive stable-stringify: sorts keys at every nesting level. Used
/// for `probe` because that field is `Record<string, unknown>` from an
/// external owner — we cannot trust its insertion order.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const inner = keys
    .map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k]))
    .join(',');
  return '{' + inner + '}';
}

export async function writeAuditLog(
  client: Storage0GClient,
  payload: AuditLogPayload,
  opts: WriteAuditLogOptions = {}
): Promise<Result<WriteAuditLogSuccess, StorageError>> {
  if (payload.version !== '1') {
    return {
      ok: false,
      error: { kind: 'malformed_payload', reason: `unknown version ${String(payload.version)}` },
    };
  }
  if (typeof payload.auditedAt !== 'string' || payload.auditedAt.length === 0) {
    return {
      ok: false,
      error: { kind: 'malformed_payload', reason: 'auditedAt must be non-empty ISO-8601' },
    };
  }

  let canonical: string;
  try {
    canonical = canonicalizeAuditPayload(payload);
  } catch (e) {
    return { ok: false, error: { kind: 'malformed_payload', reason: errMsg(e) } };
  }

  const bytes = new TextEncoder().encode(canonical);
  const payloadHash = keccak256(toBytes(canonical));

  let rootHash: Hex;
  let txHash: Hex;
  try {
    const out = await client.upload(bytes);
    rootHash = out.rootHash;
    txHash = out.txHash;
  } catch (e) {
    return { ok: false, error: classifyUploadError(e) };
  }

  return {
    ok: true,
    value: {
      rootHash,
      txHash,
      payloadHash,
      ...(opts.includeCanonical ? { canonical } : {}),
    },
  };
}

/// Heuristic error classification. The 0g-ts-sdk surfaces transport,
/// gas-rejection and indexer-routing failures as plain Error messages —
/// we lift signer-rejection patterns to a dedicated variant so callers
/// can retry config vs signer issues differently.
function classifyUploadError(e: unknown): StorageError {
  const msg = errMsg(e).toLowerCase();
  if (
    msg.includes('insufficient funds') ||
    msg.includes('user rejected') ||
    msg.includes('signer')
  ) {
    return { kind: 'signer_rejected', reason: errMsg(e) };
  }
  return { kind: 'upload_failed', reason: errMsg(e) };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
