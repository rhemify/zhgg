import type { Provider, InferenceResult } from '../intent.js';
import type { Result } from '../result.js';

export type AdapterError =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'wrong_adapter'; reason: string }
  | { kind: 'invalid_provider'; reason: string }
  | { kind: 'payment_failed'; reason: string }
  | { kind: 'attestation_failed'; reason: string }
  | { kind: 'timeout'; reason: string }
  | { kind: 'transport'; reason: string };

export interface AdapterCapabilities {
  readonly tee: boolean;
}

export interface InferenceAdapter {
  readonly id: 'zg' | 'x402';
  readonly capabilities: AdapterCapabilities;
  listProviders(opts?: { maxCostUsd?: number; maxLatencyMs?: number }): Promise<Provider[]>;
  infer(provider: Provider, prompt: string): Promise<Result<InferenceResult, AdapterError>>;
}

export function adapterError(
  kind: AdapterError['kind'],
  reason: string,
): { ok: false; error: AdapterError } {
  return { ok: false, error: { kind, reason } };
}
