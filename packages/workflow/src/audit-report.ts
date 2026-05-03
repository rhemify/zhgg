/// Canonical audit-report writer — Slice Y.
///
/// Builds the tamper-proof JSON evidence chain that an EU AI Act regulator
/// queries. Output is anchored on 0G Storage and self-references its own
/// keccak256 — the URI + hash pair is what gets recorded on chain via
/// ERC-8004 `giveFeedback`.
///
/// Three exports compose the writer:
///   1. `buildAuditReport(input)` — pure constructor: orchestrator's
///      collected evidence → typed AuditReport. No I/O.
///   2. `canonicalizeAuditReport(report)` — deterministic, key-sorted
///      UTF-8 bytes + their keccak256. The `anchors.feedbackTx` field is
///      forced to null during canonicalization so the hash is stable BEFORE
///      the on-chain `giveFeedback` tx hash is known. The hash baked into
///      the report itself is `anchors.feedbackHash`, computed over the
///      report-with-feedbackTx-cleared (a self-referential fixed point).
///   3. `writeAuditReport(report, opts)` — uploads canonical bytes to 0G
///      Storage when enabled (default-on; opt out via `ZG_STORAGE_ENABLED=0`),
///      returns the storage CID as `uri`. Refuses with a named error when
///      `ZG_STORAGE_ENABLED === '0'` or no explicit client is supplied.
///      NEVER falls back to a fake URI.
///
/// Determinism is the whole point: any verifier in any language can
/// re-canonicalize the report (with `anchors.feedbackTx = null`) and
/// recompute keccak256 to confirm `anchors.feedbackHash` matches the
/// `feedbackHash` field emitted in `NewFeedback`. If they match, the
/// report bytes pinned at `anchors.storageURI` are the exact bytes the
/// auditor agreed to on chain.

import { keccak256, type Address, type Hex } from 'viem';
import type { Result } from './adapters/zg-router.js';
import type { Storage0GClient } from './storage-log.js';

export type FindingStatus = 'pass' | 'fail' | 'inconclusive';

export interface AuditReportFinding {
  article: string;
  status: FindingStatus;
  evidence: string;
  qwenReasoning?: Hex;
}

export interface AuditReport {
  version: '1.0';
  auditorAgent: {
    iNFTAddress: Address;
    /// bigint encoded as decimal string for cross-language JSON parity.
    tokenId: string;
    ens: string;
    /// keccak of the auditor's `capabilities()` bytes at audit time.
    manifestHash: Hex;
    owner: Address;
  };
  subjectAgent: {
    tokenId: string;
    ens?: string;
    capabilitiesAtAudit: Hex;
    registeredAtBlock: string;
  };
  regulation: {
    framework: string;
    articlesProbed: string[];
    regulatorySource?: { type: string; publishedAt?: string; fetchedFromCID?: string };
  };
  evidenceChain: {
    axiomCommit?: { commitId: Hex; commitTx: Hex; commitBlock: string };
    qwenInference?: {
      modelId: string;
      providerAddress?: Address;
      promptHash: Hex;
      responseHash: Hex;
      /// Null when the TEE attestation is absent (e.g. ZG_ROUTER_KEY
      /// unfunded → synthetic inference). Honest signal to the regulator:
      /// no attestation means no in-TEE proof of inference.
      teeAttestation?: Hex;
      verifiedAtBlock?: string;
    };
    settlement?: {
      rail: 'x402' | 'direct_split';
      tx: Hex;
      /// Atomic-units string, e.g. "100000" for 0.1 USDC at 6 decimals.
      amount: string;
      splitBPS?: number[];
    };
    axiomReveal?: { commitId: Hex; revealTx: Hex; revealBlock: string };
  };
  verdict: {
    compliant: boolean;
    findings: AuditReportFinding[];
    /// 0..1
    confidence: number;
    /// ERC-8004 `value`. Convention: -100..+100.
    valueSigned: number;
    /// ERC-8004 `valueDecimals`. 2 → percent-points.
    valueDecimals: number;
  };
  anchors: {
    /// Set by the orchestrator AFTER `giveFeedback` returns. Excluded from
    /// the canonical bytes so the hash is stable before the tx exists.
    feedbackTx?: Hex;
    /// keccak256 of the canonical bytes of THIS document with
    /// `anchors.feedbackTx` forced to null. Self-referential fixed point.
    feedbackHash: Hex;
    /// 0G Storage rootHash returned by `writeAuditReport`. Empty string
    /// is reserved for "evidence not yet pinned" — set when ZG_STORAGE
    /// is disabled and the orchestrator still wants to post on chain.
    storageURI: string;
  };
  /// Stretch goal — auditor EOA signature over the canonical bytes (with
  /// `feedbackTx=null` AND `feedbackHash="0x"+0*64` zeroed for signing).
  /// Currently unused.
  auditorSignature?: Hex;
}

// ─── Build ───────────────────────────────────────────────────────────

export interface BuildAuditReportInput {
  auditorAgent: AuditReport['auditorAgent'];
  subjectAgent: AuditReport['subjectAgent'];
  regulation: AuditReport['regulation'];
  evidenceChain: AuditReport['evidenceChain'];
  verdict: AuditReport['verdict'];
}

/// Pure constructor: validates required fields and assembles the typed
/// AuditReport. Hash + URI fields are placeholders — populated by
/// `canonicalizeAuditReport` and `writeAuditReport`.
///
/// Throws `AuditReportError` (kind='missing_field') with a named field
/// when a required slot is missing. Optional fields (axiomCommit,
/// settlement, etc.) are passed through verbatim.
export function buildAuditReport(input: BuildAuditReportInput): AuditReport {
  // Reviewer fix #2 — hex slots are validated against `0x[0-9a-fA-F]+`
  // so a typo doesn't silently produce a "valid" report that fails
  // strict viem decoders or regulator-side hash verification.
  requireHex(input.auditorAgent?.iNFTAddress, 'auditorAgent.iNFTAddress');
  requireString(input.auditorAgent?.tokenId, 'auditorAgent.tokenId');
  requireString(input.auditorAgent?.ens, 'auditorAgent.ens');
  requireHex(input.auditorAgent?.manifestHash, 'auditorAgent.manifestHash');
  requireHex(input.auditorAgent?.owner, 'auditorAgent.owner');
  requireString(input.subjectAgent?.tokenId, 'subjectAgent.tokenId');
  requireHex(input.subjectAgent?.capabilitiesAtAudit, 'subjectAgent.capabilitiesAtAudit');
  requireString(input.subjectAgent?.registeredAtBlock, 'subjectAgent.registeredAtBlock');
  requireString(input.regulation?.framework, 'regulation.framework');
  if (!Array.isArray(input.regulation?.articlesProbed)) {
    throw new AuditReportError('missing_field', 'regulation.articlesProbed');
  }
  if (typeof input.verdict?.compliant !== 'boolean') {
    throw new AuditReportError('missing_field', 'verdict.compliant');
  }
  if (!Array.isArray(input.verdict?.findings)) {
    throw new AuditReportError('missing_field', 'verdict.findings');
  }
  if (typeof input.verdict?.confidence !== 'number') {
    throw new AuditReportError('missing_field', 'verdict.confidence');
  }
  if (typeof input.verdict?.valueSigned !== 'number') {
    throw new AuditReportError('missing_field', 'verdict.valueSigned');
  }
  if (typeof input.verdict?.valueDecimals !== 'number') {
    throw new AuditReportError('missing_field', 'verdict.valueDecimals');
  }

  return {
    version: '1.0',
    auditorAgent: input.auditorAgent,
    subjectAgent: input.subjectAgent,
    regulation: input.regulation,
    evidenceChain: input.evidenceChain,
    verdict: input.verdict,
    anchors: {
      // placeholders — `canonicalizeAuditReport` overwrites feedbackHash,
      // `writeAuditReport` overwrites storageURI, orchestrator stamps
      // feedbackTx after `giveFeedback` returns.
      feedbackHash: ZERO_HASH,
      storageURI: '',
    },
  };
}

// ─── Canonicalize ────────────────────────────────────────────────────

/// Recursive key-sorted JSON.stringify. No whitespace, stable across
/// runs. `undefined` properties are dropped (matches JSON.stringify).
/// Arrays keep insertion order — only object keys sort.
///
/// Reviewer fix #3 — `bigint` values are explicitly rejected with a
/// typed `AuditReportError(invalid_hex)` (re-using the kind because
/// the field path is named for grepability). The schema documents
/// "bigint encoded as decimal string for cross-language JSON parity"
/// but nothing else enforces it; without this guard, `JSON.stringify`
/// would throw `TypeError: Do not know how to serialize a BigInt` mid-
/// canonicalization with no breadcrumbs about which field. We surface
/// the field path so the operator can fix the caller, not chase a
/// stack trace.
export function canonicalJsonStringify(value: unknown, path = '<root>'): string {
  if (value === undefined) return 'null';
  if (typeof value === 'bigint') {
    throw new AuditReportError('invalid_hex', `${path} (bigint must be string-encoded)`);
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v, i) => canonicalJsonStringify(v, `${path}[${i}]`)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const inner = keys
    .map((k) => JSON.stringify(k) + ':' + canonicalJsonStringify(obj[k], `${path}.${k}`))
    .join(',');
  return '{' + inner + '}';
}

export interface CanonicalAuditReport {
  bytes: Uint8Array;
  hash: Hex;
}

/// Canonicalize an AuditReport for hashing or pinning. The
/// `anchors.feedbackTx` field is forced to absent so the keccak is
/// stable BEFORE the on-chain `giveFeedback` tx exists. The
/// `anchors.feedbackHash` field is also zeroed in the canonical view
/// (otherwise hashing the report would depend on its own hash — a fixed
/// point with no closed-form solution).
///
/// To verify a report against `NewFeedback.feedbackHash`:
///   1. Fetch report bytes from `anchors.storageURI`.
///   2. JSON.parse, then re-canonicalize via this function.
///   3. Compare returned `hash` against `NewFeedback.feedbackHash`.
export function canonicalizeAuditReport(report: AuditReport): CanonicalAuditReport {
  // Strip mutable post-write fields so the hash is content-only.
  const stripped: AuditReport = {
    ...report,
    anchors: {
      // Drop feedbackTx entirely (canonicalJsonStringify omits undefined)
      feedbackHash: ZERO_HASH,
      storageURI: report.anchors.storageURI,
    },
  };
  const json = canonicalJsonStringify(stripped);
  const bytes = new TextEncoder().encode(json);
  const hash = keccak256(bytes);
  return { bytes, hash };
}

// ─── Write ───────────────────────────────────────────────────────────

export type WriteAuditReportError =
  | { kind: 'storage_disabled'; reason: string }
  | { kind: 'no_client'; reason: string }
  | { kind: 'upload_failed'; reason: string };

export interface WriteAuditReportOptions {
  /// 0G Storage adapter. When omitted, writeAuditReport refuses with
  /// `no_client`. Live wiring lives in `./storage-log-zg.ts`.
  client?: Storage0GClient;
  /// Defaults to `process.env.ZG_STORAGE_ENABLED !== '0'` (default-on;
  /// opt out by setting `ZG_STORAGE_ENABLED=0`). Pass an explicit value
  /// for deterministic tests.
  enabled?: boolean;
}

export interface WriteAuditReportSuccess {
  /// 0G Storage rootHash (also written to `anchors.storageURI` in the
  /// returned report by callers — kept separate so the callee doesn't
  /// mutate its input).
  uri: string;
  /// keccak256 of the canonical bytes — same value baked into the
  /// returned report's `anchors.feedbackHash`.
  hash: Hex;
  /// The mutated copy of the input report, with `anchors.storageURI`
  /// and `anchors.feedbackHash` populated. Caller passes this to
  /// ERC-8004 `giveFeedback`.
  report: AuditReport;
}

/// Pin canonical AuditReport bytes to 0G Storage. Returns the rootHash
/// as `uri` (same convention as ERC-8004 spec — a CID-shaped string
/// uniquely identifying the bytes). Refuses with a named error when
/// `ZG_STORAGE_ENABLED === '0'` or no client is supplied — NEVER falls
/// back to a fake URI. The orchestrator can still emit a 0-URI receipt
/// (`feedbackURI=""`, `feedbackHash=0x0`) to indicate "evidence not yet
/// pinned" — that's an honest signal a regulator can verify.
export async function writeAuditReport(
  report: AuditReport,
  opts: WriteAuditReportOptions = {}
): Promise<Result<WriteAuditReportSuccess, WriteAuditReportError>> {
  const enabled = opts.enabled ?? process.env.ZG_STORAGE_ENABLED !== '0';
  if (!enabled) {
    return {
      ok: false,
      error: {
        kind: 'storage_disabled',
        reason: 'ZG_STORAGE_ENABLED === "0"; refusing to fabricate a fake URI',
      },
    };
  }
  if (!opts.client) {
    return {
      ok: false,
      error: {
        kind: 'no_client',
        reason: 'no Storage0GClient supplied; pass opts.client to writeAuditReport',
      },
    };
  }

  // Compute the canonical bytes + hash FIRST so the hash baked into
  // the returned report matches the bytes we actually upload. We then
  // reuse the same canonical bytes for the upload — re-canonicalizing
  // post-hash insertion is a no-op because `anchors.feedbackHash` is
  // zeroed during canonicalization.
  const { bytes, hash } = canonicalizeAuditReport(report);

  let rootHash: Hex;
  try {
    const out = await opts.client.upload(bytes);
    rootHash = out.rootHash;
  } catch (e) {
    return {
      ok: false,
      error: { kind: 'upload_failed', reason: e instanceof Error ? e.message : String(e) },
    };
  }

  // Returned report has both anchors populated. feedbackTx is still
  // absent — orchestrator stamps it after giveFeedback returns, but
  // that mutation is OFF-CHAIN and does not affect the stored bytes
  // (the stored bytes already exclude feedbackTx via canonicalization).
  const populated: AuditReport = {
    ...report,
    anchors: {
      ...report.anchors,
      feedbackHash: hash,
      storageURI: rootHash,
    },
  };

  return {
    ok: true,
    value: { uri: rootHash, hash, report: populated },
  };
}

// ─── Errors / helpers ────────────────────────────────────────────────

export class AuditReportError extends Error {
  constructor(
    /// `missing_field` — required slot absent or empty.
    /// `invalid_hex`   — string present but doesn't match `0x[0-9a-fA-F]+`.
    ///                   Reviewer fix #2: catches typos that would silently
    ///                   pass strict viem decoders downstream and corrupt
    ///                   the regulator's verification flow.
    public readonly kind: 'missing_field' | 'invalid_hex',
    public readonly field: string
  ) {
    super(`AuditReportError(${kind}): ${field}`);
    this.name = 'AuditReportError';
  }
}

const ZERO_HASH: Hex = `0x${'0'.repeat(64)}` as Hex;
const HEX_RE = /^0x[a-fA-F0-9]+$/;

function requireString(v: unknown, field: string): asserts v is string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new AuditReportError('missing_field', field);
  }
}

/// Reviewer fix #2 — validates `0x[0-9a-fA-F]+` shape on top of the
/// presence check. Empty / non-string still surfaces as `missing_field`
/// (cheap-to-grep test) so the error kind matches operator intuition;
/// malformed hex surfaces as `invalid_hex` so it's distinguishable from
/// a missing slot.
function requireHex(v: unknown, field: string): asserts v is `0x${string}` {
  requireString(v, field);
  if (!HEX_RE.test(v)) {
    throw new AuditReportError('invalid_hex', field);
  }
}
