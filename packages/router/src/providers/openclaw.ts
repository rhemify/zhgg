import type { Mode, OutputType, RouteResult } from '../intent.js';
import type { ExecutionScope } from '../scope.js';
import type { Router } from '../router.js';

/**
 * zhgg ↔ OpenClaw integration adapter.
 *
 * Drop into an OpenClaw runtime via a thin `ProviderPlugin` wrapper (NOT
 * shipped here — that's post-hackathon work). Models
 * `zhgg/fast`, `zhgg/verified`, `zhgg/consensus`, `zhgg/pipeline` flow
 * through the supplied router, which orchestrates 0G + Bazaar adapters,
 * KeeperHub settlement, and 0G Storage audit log.
 *
 * SHAPE NOTICE: this is NOT the official `openclaw.ProviderPlugin` shape.
 * The real SDK (`openclaw/dist/plugin-sdk/.../plugins/types.d.ts`) requires
 * `auth: ProviderAuthMethod[]`, `catalog`/`staticCatalog`/`discovery`
 * runtime hooks, dynamic-model resolvers, and more. For the hackathon we
 * expose just the inference-call surface (the part judges care about) and
 * leave the full SDK adapter as a Phase 6/7 / post-hackathon item.
 */
export interface OpenClawMessage {
  role: 'system' | 'user' | 'assistant' | string;
  content: string;
}

export interface OpenClawCompletionRequest {
  model: string;
  messages: readonly OpenClawMessage[];
  metadata?: {
    max_cost_usd?: number;
    max_latency_ms?: number;
    output_type?: OutputType;
  };
}

export interface OpenClawCompletionResponse {
  id: string;
  model: string;
  choices: ReadonlyArray<{
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: 'stop' | 'low_confidence' | 'attestation_required';
  }>;
  usage: {
    prompt_chars: number;
    completion_chars: number;
  };
  /** zhgg-specific metadata mirrored from RouteResult. */
  zhgg: {
    mode: Mode;
    cost_usd: number;
    latency_ms: number;
    attestation_root: string | null;
    audit_cid: string | null;
    agreement_score: number | null;
    low_confidence: boolean;
    provider_ids: readonly string[];
    receipts: readonly string[];
  };
}

export interface OpenClawProviderHandler {
  (request: OpenClawCompletionRequest): Promise<OpenClawCompletionResponse>;
}

/** Local interface — does NOT match openclaw.ProviderPlugin (see file header). */
export interface ZhggOpenClawAdapter {
  readonly id: 'zhgg';
  readonly displayName: string;
  readonly models: ReadonlyArray<{
    id: string;
    capabilities: ReadonlyArray<'tee' | 'consensus' | 'cheap' | 'multi-step'>;
    description: string;
  }>;
  readonly handler: OpenClawProviderHandler;
}

/** @deprecated Use ZhggOpenClawAdapter — name does not match openclaw.ProviderPlugin. */
export type OpenClawProviderPlugin = ZhggOpenClawAdapter;

const MODEL_TO_MODE: Record<string, Mode> = {
  'zhgg/fast': 'fast',
  'zhgg/verified': 'verified',
  'zhgg/consensus': 'consensus',
  'zhgg/pipeline': 'pipeline',
  // 'auto' → 'verified': fail-safe default. Agents that explicitly want cheap
  // commodity inference must opt in to 'zhgg/fast'. Spec philosophy: if you
  // didn't declare a trust level, assume the call has on-chain consequences.
  'zhgg/auto': 'verified',
};

const SUPPORTED_MODELS = Object.keys(MODEL_TO_MODE);

const DEFAULT_MAX_COST_USD = 0.001;
const DEFAULT_MAX_LATENCY_MS = 5_000;
const DEFAULT_OUTPUT_TYPE: OutputType = 'freeform';

function joinMessages(messages: readonly OpenClawMessage[]): string {
  // OpenClaw conversations may have system + user + assistant turns. zhgg
  // routes a single inference at a time — concatenate the conversation as a
  // structured prompt with role labels.
  return messages
    .map((m) => {
      const role = m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User';
      return `${role}: ${m.content}`;
    })
    .join('\n\n');
}

function pickFinishReason(route: RouteResult): OpenClawCompletionResponse['choices'][number]['finish_reason'] {
  if (route.low_confidence) return 'low_confidence';
  // The router already fails closed on missing attestation in verified/pipeline/
  // consensus modes (router.ts mapPhaseError + attestation_required RouteError),
  // so reaching this branch means a successful Result.ok with non-null root.
  // The `attestation_required` literal is kept in the union for downstream
  // OpenClaw consumers who may add their own pre-checks.
  return 'stop';
}

export interface CreateOpenClawProviderOptions {
  router: Router;
  scope: ExecutionScope;
  /** Display name shown in OpenClaw model picker UIs. */
  displayName?: string;
}

export function createOpenClawProvider(
  opts: CreateOpenClawProviderOptions,
): ZhggOpenClawAdapter {
  const handler: OpenClawProviderHandler = async (request) => {
    if (!SUPPORTED_MODELS.includes(request.model)) {
      throw new Error(
        `zhgg provider: unsupported model '${request.model}'. Use one of: ${SUPPORTED_MODELS.join(', ')}`,
      );
    }
    const mode = MODEL_TO_MODE[request.model]!;
    const prompt = joinMessages(request.messages);

    const result = await opts.router.route(
      {
        prompt,
        mode,
        max_cost_usd: request.metadata?.max_cost_usd ?? DEFAULT_MAX_COST_USD,
        max_latency_ms: request.metadata?.max_latency_ms ?? DEFAULT_MAX_LATENCY_MS,
        output_type: request.metadata?.output_type ?? DEFAULT_OUTPUT_TYPE,
      },
      opts.scope,
    );

    if (!result.ok) {
      const reason =
        result.error.kind === 'policy'
          ? `policy: ${result.error.violations.map((v) => v.rule).join(', ')}`
          : `${result.error.kind}: ${result.error.reason}`;
      throw new Error(`zhgg provider: ${reason}`);
    }

    const route = result.value;
    return {
      id: route.receipt,
      model: request.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: route.response },
          finish_reason: pickFinishReason(route),
        },
      ],
      usage: {
        prompt_chars: prompt.length,
        completion_chars: route.response.length,
      },
      zhgg: {
        mode: route.mode,
        cost_usd: route.cost_usd,
        latency_ms: route.latency_ms,
        attestation_root: route.attestation_root,
        audit_cid: route.audit_cid,
        agreement_score: route.agreement_score,
        low_confidence: route.low_confidence,
        provider_ids: route.provider_ids,
        receipts: route.receipts,
      },
    };
  };

  return {
    id: 'zhgg',
    displayName: opts.displayName ?? 'zhgg — trust-level inference router',
    models: [
      {
        id: 'zhgg/fast',
        capabilities: ['cheap'],
        description: 'Cheapest live provider. No attestation. Best for routine classification.',
      },
      {
        id: 'zhgg/verified',
        capabilities: ['tee'],
        description: 'TEE-attested 0G Compute. Required for on-chain consequential decisions.',
      },
      {
        id: 'zhgg/consensus',
        capabilities: ['consensus', 'tee'],
        description: 'N providers in parallel + TEE anchor. Use when accuracy AND proof matter.',
      },
      {
        id: 'zhgg/pipeline',
        capabilities: ['multi-step', 'tee'],
        description: 'Cheap research → TEE-attested decision. Use for multi-step reasoning.',
      },
      {
        id: 'zhgg/auto',
        capabilities: ['tee'],
        description:
          'Fail-safe default. Routes to verified mode (TEE) unless metadata overrides.',
      },
    ],
    handler,
  };
}

export { MODEL_TO_MODE as ZHGG_MODEL_MAPPING, SUPPORTED_MODELS as ZHGG_SUPPORTED_MODELS };
