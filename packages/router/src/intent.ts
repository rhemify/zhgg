import { z } from 'zod';

export const MODES = ['fast', 'verified', 'consensus', 'pipeline'] as const;
export type Mode = (typeof MODES)[number];

export const OUTPUT_TYPES = ['categorical', 'freeform', 'numeric', 'json'] as const;
export type OutputType = (typeof OUTPUT_TYPES)[number];

export const ADAPTERS = ['zg', 'x402'] as const;
export type Adapter = (typeof ADAPTERS)[number];

export interface Provider {
  id: string;
  model: string;
  tee: boolean;
  price_per_call_usd: number;
  latency_p50_ms: number;
  adapter: Adapter;
  endpoint?: string;
}

export const InferenceIntent = z.object({
  prompt: z.string().min(1),
  mode: z.enum(MODES).default('fast'),
  max_cost_usd: z.number().positive(),
  max_latency_ms: z.number().positive(),
  output_type: z.enum(OUTPUT_TYPES).default('freeform'),
});

export type InferenceIntent = z.infer<typeof InferenceIntent>;

export interface InferenceResult {
  response: string;
  cost_usd: number;
  latency_ms: number;
  attestation_root: string | null;
  receipt: string;
  provider_id: string;
}

export interface RouteResult {
  response: string;
  cost_usd: number;
  latency_ms: number;
  attestation_root: string | null;
  // Anchor identity for human-friendly display. May be synthetic in consensus
  // mode (e.g. when the consensus_response is a synthesized mean and no single
  // call produced it). Audit logs MUST use the arrays below, not these fields.
  provider_id: string;
  receipt: string;
  // Source-of-truth audit arrays. One entry per participating call:
  //   fast / verified  → length 1
  //   consensus        → length N (typically 3)
  //   pipeline         → length 2 (research, decision)
  provider_ids: string[];
  receipts: string[];
  mode: Mode;
  agreement_score: number | null;
  outliers: string[];
  low_confidence: boolean;
  audit_cid: string | null;
}
