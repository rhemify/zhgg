/// 0G Compute TEE attestation verifier.
///
/// Two modes:
///   RELAXED (default): parse the attestation envelope, validate shape,
///     log a warning that cryptographic TDX validation is deferred.
///   STRICT (`opts.strict: true`): POST the raw quote to `opts.verifierUrl`
///     (dstack / CryptoPilot verifier sidecar) and trust its boolean
///     result. Drop in the dstack verifier later without touching
///     `inferZG`.
///
/// Reality check the SPEC honesty pass already flagged:
/// the hosted 0G Compute Router (`router-api.0g.ai/v1`) does NOT emit
/// `x-tee-attestation` headers today. Per-response attestation is only
/// available via the direct broker SDK at
/// `${providerBrokerURL}/v1/proxy/attestation/report` (TDX quote
/// envelope) and `${providerBrokerURL}/v1/proxy/signature/${chatID}`
/// (per-response ECDSA signature). This verifier is shape-correct now;
/// it'll only fire meaningfully once the broker SDK path is wired in
/// or the router starts forwarding `chatID` + provider URL headers.
///
/// Envelope shape (from
/// 0gfoundation/0g-serving-user-broker/src.ts/sdk/inference/broker/verifier.ts):
///   { signing_address: "0x...",
///     signing_algo:    "ecdsa",
///     request_nonce:   "<hex>",
///     intel_quote:     "<hex>" }

import { hashMessage, isAddress, recoverAddress, type Hex } from 'viem';
import type { Result } from './adapters/zg-router.js';

const SUPPORTED_ALGOS = ['ecdsa'] as const;
type SupportedAlgo = (typeof SUPPORTED_ALGOS)[number];

export interface TeeAttestationEnvelope {
  signing_address: string;
  signing_algo: SupportedAlgo;
  request_nonce: string;
  intel_quote: string;
}

export interface VerifiedAttestation {
  /// `signing_address` from the envelope, lowercased.
  verifierId: string;
  /// Wall-clock ms when this verifier ran (NOT when the TEE signed).
  attestedAt: number;
  algo: SupportedAlgo;
  mode: 'relaxed' | 'strict';
  /// Address recovered from the per-response signature, if supplied. We
  /// require it to match `signing_address` — mismatch fails the verify.
  recoveredFromSignature: string | null;
  quoteBytes: number;
}

export type AttestError =
  | { kind: 'missing'; reason: string }
  | { kind: 'malformed'; reason: string }
  | { kind: 'unsupported_algo'; algo: string }
  | { kind: 'signature_mismatch'; expected: string; recovered: string }
  | { kind: 'verifier_rejected'; reason: string }
  | { kind: 'verifier_unreachable'; reason: string };

export interface VerifyOptions {
  /// STRICT mode: delegate quote validation to a dstack verifier sidecar.
  strict?: boolean;
  /// Required when `strict: true` — e.g. `https://verifier.example/api/verify`.
  verifierUrl?: string;
  /// Optional: when supplied, ecrecover from
  /// `hashMessage(text)` against `signature` and confirm the recovered
  /// address matches `signing_address`. Real crypto, viem-native.
  responseSignature?: { text: string; signature: Hex };
  /// Pluggable fetch (tests pass a stub).
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /// Pluggable logger (tests assert on warnings).
  logger?: { warn: (msg: string) => void };
}

export async function verifyTeeAttestation(
  headerValue: string | null | undefined,
  opts: VerifyOptions = {}
): Promise<Result<VerifiedAttestation, AttestError>> {
  if (!headerValue || headerValue.trim() === '') {
    return { ok: false, error: { kind: 'missing', reason: 'no attestation header or body' } };
  }

  let env: TeeAttestationEnvelope;
  try {
    const trimmed = headerValue.trim();
    const raw = trimmed.startsWith('{') ? trimmed : safeBase64Decode(trimmed);
    env = JSON.parse(raw) as TeeAttestationEnvelope;
  } catch (e) {
    return { ok: false, error: { kind: 'malformed', reason: `not JSON: ${msg(e)}` } };
  }

  if (typeof env !== 'object' || env === null) {
    return { ok: false, error: { kind: 'malformed', reason: 'envelope not an object' } };
  }
  if (typeof env.signing_address !== 'string' || !isAddress(env.signing_address)) {
    return { ok: false, error: { kind: 'malformed', reason: 'signing_address missing/invalid' } };
  }
  if (typeof env.signing_algo !== 'string') {
    return { ok: false, error: { kind: 'malformed', reason: 'signing_algo missing' } };
  }
  if (!SUPPORTED_ALGOS.includes(env.signing_algo as SupportedAlgo)) {
    return { ok: false, error: { kind: 'unsupported_algo', algo: env.signing_algo } };
  }
  if (typeof env.intel_quote !== 'string' || env.intel_quote.length < 64) {
    return { ok: false, error: { kind: 'malformed', reason: 'intel_quote missing/too short' } };
  }
  if (typeof env.request_nonce !== 'string' || env.request_nonce.length === 0) {
    return { ok: false, error: { kind: 'malformed', reason: 'request_nonce missing' } };
  }

  // Optional: ecrecover the per-response signature against signing_address.
  // The ONLY part with real crypto when running on top of the hosted router.
  let recovered: string | null = null;
  if (opts.responseSignature) {
    try {
      const addr = await recoverAddress({
        hash: hashMessage(opts.responseSignature.text),
        signature: opts.responseSignature.signature,
      });
      recovered = addr.toLowerCase();
      if (recovered !== env.signing_address.toLowerCase()) {
        return {
          ok: false,
          error: { kind: 'signature_mismatch', expected: env.signing_address, recovered },
        };
      }
    } catch (e) {
      return { ok: false, error: { kind: 'malformed', reason: `bad signature: ${msg(e)}` } };
    }
  }

  const quoteBytes = Math.floor(env.intel_quote.replace(/^0x/, '').length / 2);

  if (!opts.strict) {
    (opts.logger ?? console).warn(
      '[tee-attestation] RELAXED mode: TDX quote shape OK but cryptographic ' +
        'validation against Intel platform CA is NOT performed. Set strict=true ' +
        `and pass verifierUrl for production. (signer=${env.signing_address.toLowerCase()}, quoteBytes=${quoteBytes})`
    );
    return {
      ok: true,
      value: {
        verifierId: env.signing_address.toLowerCase(),
        attestedAt: Date.now(),
        algo: env.signing_algo as SupportedAlgo,
        mode: 'relaxed',
        recoveredFromSignature: recovered,
        quoteBytes,
      },
    };
  }

  if (!opts.verifierUrl) {
    return {
      ok: false,
      error: { kind: 'verifier_unreachable', reason: 'strict=true but no verifierUrl' },
    };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(opts.verifierUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intel_quote: env.intel_quote,
        signing_address: env.signing_address,
        // Forward signing_algo + request_nonce so the sidecar can
        // exercise the algo and nonce-binding checks. Without these,
        // the wrapper path would bypass the very protections those
        // checks add (codex Q4 + Q6 follow-up).
        signing_algo: env.signing_algo,
        request_nonce: env.request_nonce,
      }),
    });
  } catch (e) {
    return { ok: false, error: { kind: 'verifier_unreachable', reason: msg(e) } };
  }
  if (!res.ok) {
    return { ok: false, error: { kind: 'verifier_rejected', reason: `HTTP ${res.status}` } };
  }
  let body: { valid?: boolean; reason?: string };
  try {
    body = (await res.json()) as { valid?: boolean; reason?: string };
  } catch (e) {
    return { ok: false, error: { kind: 'verifier_rejected', reason: `bad json: ${msg(e)}` } };
  }
  if (body.valid !== true) {
    return {
      ok: false,
      error: { kind: 'verifier_rejected', reason: body.reason ?? 'valid!=true' },
    };
  }
  return {
    ok: true,
    value: {
      verifierId: env.signing_address.toLowerCase(),
      attestedAt: Date.now(),
      algo: env.signing_algo as SupportedAlgo,
      mode: 'strict',
      recoveredFromSignature: recovered,
      quoteBytes,
    },
  };
}

function safeBase64Decode(s: string): string {
  // tolerate URL-safe base64
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  if (typeof Buffer !== 'undefined') return Buffer.from(norm, 'base64').toString('utf8');
  return atob(norm);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
