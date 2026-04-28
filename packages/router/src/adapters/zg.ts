import { createHash } from 'node:crypto';
import {
  adapterError,
  type AdapterError,
  type InferenceAdapter,
} from './types.js';
import type { Provider, InferenceResult } from '../intent.js';
import type { Result } from '../result.js';
import { loadEnv } from '../constants.js';

export interface ZgService {
  readonly provider: string;
  readonly url: string;
  readonly inputPrice: bigint;
  readonly outputPrice: bigint;
  readonly model: string;
  readonly verifiability: string;
  readonly teeSignerAcknowledged: boolean;
}

export interface BrokerLike {
  inference: {
    listService(): Promise<readonly ZgService[]>;
    getServiceMetadata(providerAddress: string): Promise<{ endpoint: string; model: string }>;
    getRequestHeaders(providerAddress: string, content: string): Promise<Record<string, string>>;
    processResponse(
      providerAddress: string,
      chatID?: string,
      content?: string,
    ): Promise<boolean | null>;
  };
}

export interface ZgAdapterOptions {
  rpcUrl?: string;
  privateKey?: string;
  fetcher?: typeof fetch;
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenAiCompletion {
  id?: string;
  choices: Array<{ message: { content: string } }>;
  usage?: OpenAiUsage;
}

// Stub price conversion. Phase 2+ will plug in a price oracle.
const OG_USD_PRICE = 0.5;
const NEURON_PER_OG = 1_000_000_000_000_000_000n;
const ASSUMED_TOKENS_PER_CALL = 1000;

function neuronToUsd(neuron: bigint): number {
  return (Number(neuron) / Number(NEURON_PER_OG)) * OG_USD_PRICE;
}

function serviceToProvider(s: ZgService): Provider {
  const inputUsd = neuronToUsd(s.inputPrice);
  const outputUsd = neuronToUsd(s.outputPrice);
  const pricePerCall = (inputUsd + outputUsd) * ASSUMED_TOKENS_PER_CALL;
  return {
    id: `zg:${s.provider}`,
    model: s.model,
    tee: true,
    price_per_call_usd: pricePerCall,
    latency_p50_ms: 1500,
    adapter: 'zg',
    endpoint: s.url,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const ZG_PROVIDER_ID_PREFIX = 'zg:';

export function createZgAdapterFromBroker(
  broker: BrokerLike,
  opts: { fetcher?: typeof fetch } = {},
): InferenceAdapter {
  const fetcher = opts.fetcher ?? globalThis.fetch.bind(globalThis);

  return {
    id: 'zg',
    capabilities: { tee: true },

    async listProviders(query?: { maxCostUsd?: number; maxLatencyMs?: number }): Promise<Provider[]> {
      let services: readonly ZgService[];
      try {
        services = await broker.inference.listService();
      } catch (err) {
        console.warn(`zg adapter: listService failed: ${errorMessage(err)}`);
        return [];
      }

      const providers = services
        .filter((s) => s.verifiability === 'TeeML' && s.teeSignerAcknowledged === true)
        .map(serviceToProvider);

      const filtered =
        query?.maxCostUsd !== undefined
          ? providers.filter((p) => p.price_per_call_usd <= query.maxCostUsd!)
          : providers;

      return filtered.sort((a, b) => a.price_per_call_usd - b.price_per_call_usd);
    },

    async infer(
      provider: Provider,
      prompt: string,
    ): Promise<Result<InferenceResult, AdapterError>> {
      if (provider.adapter !== 'zg') {
        return adapterError('wrong_adapter', `expected adapter 'zg', got '${provider.adapter}'`);
      }
      if (!provider.id.startsWith(ZG_PROVIDER_ID_PREFIX)) {
        return adapterError('invalid_provider', `id must start with '${ZG_PROVIDER_ID_PREFIX}'`);
      }
      const providerAddress = provider.id.slice(ZG_PROVIDER_ID_PREFIX.length);

      try {
        const { endpoint, model } = await broker.inference.getServiceMetadata(providerAddress);
        const headers = await broker.inference.getRequestHeaders(providerAddress, prompt);

        const start = Date.now();
        const res = await fetcher(`${endpoint}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
        });
        const latencyMs = Date.now() - start;

        if (!res.ok) {
          return adapterError('transport', `status ${res.status}`);
        }

        let completion: OpenAiCompletion;
        try {
          completion = (await res.json()) as OpenAiCompletion;
        } catch (err) {
          return adapterError('transport', `malformed json: ${errorMessage(err)}`);
        }

        const responseText = completion.choices[0]?.message?.content ?? '';
        if (!responseText) {
          return adapterError('transport', 'empty response content');
        }

        // SDK doctrine (broker.d.ts:218): prefer header, fall back to completion.id.
        // Use || not ?? so empty string falls through to the id.
        const headerChatId = res.headers.get('ZG-Res-Key');
        const chatID = headerChatId || completion.id || '';

        const usage = completion.usage ?? {};
        const attestation = await broker.inference.processResponse(
          providerAddress,
          chatID || undefined,
          JSON.stringify(usage),
        );

        // For the TEE adapter, attestation MUST be performed. SPEC §Boundaries:
        // "Verify TEE attestation in-process before returning 0G Compute responses".
        // null = SDK skipped verification (no chatID). For us, that is failure —
        // the entire purpose of this adapter is on-chain provable inference.
        if (attestation === false) {
          return adapterError('attestation_failed', 'TEE signature mismatch');
        }
        if (attestation === null) {
          return adapterError(
            'attestation_failed',
            'verification skipped (no chatID extracted from response)',
          );
        }

        const totalTokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
        const costUsd =
          totalTokens > 0
            ? (provider.price_per_call_usd * totalTokens) / ASSUMED_TOKENS_PER_CALL
            : provider.price_per_call_usd;

        // Phase 1 stub for attestation_root: sha256(providerAddress | chatID).
        // This proves the contract (non-null hex root) and is deterministic per
        // (provider, session). Phase 3 audit step replaces this with the real
        // keccak256 over the SDK's signing tuple (signing-address, msg-hash, sig).
        const stubRoot =
          '0x' + createHash('sha256').update(`${providerAddress}|${chatID}`).digest('hex');

        return {
          ok: true,
          value: {
            response: responseText,
            cost_usd: costUsd,
            latency_ms: latencyMs,
            attestation_root: stubRoot,
            receipt: chatID,
            provider_id: provider.id,
          },
        };
      } catch (err) {
        return adapterError('transport', errorMessage(err));
      }
    },
  };
}

export function createZgAdapter(opts: ZgAdapterOptions = {}): InferenceAdapter {
  const fetcher = opts.fetcher ?? globalThis.fetch.bind(globalThis);
  let cachedBroker: BrokerLike | null = null;
  let cachedKey: string | null = null;

  async function getBroker(): Promise<BrokerLike> {
    const env = loadEnv();
    const rpcUrl = opts.rpcUrl ?? env.ZG_RPC_URL;
    const privateKey = opts.privateKey ?? env.ZG_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('zg adapter not configured');
    }
    const cacheKey = `${rpcUrl}|${privateKey}`;
    if (cachedBroker && cachedKey === cacheKey) return cachedBroker;

    const ethers = await import('ethers');
    const sdk = await import('@0glabs/0g-serving-broker');
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);
    const broker = (await sdk.createZGComputeNetworkBroker(
      wallet as unknown as Parameters<typeof sdk.createZGComputeNetworkBroker>[0],
    )) as unknown as BrokerLike;
    cachedBroker = broker;
    cachedKey = cacheKey;
    return broker;
  }

  return {
    id: 'zg',
    capabilities: { tee: true },

    async listProviders(query?: { maxCostUsd?: number; maxLatencyMs?: number }): Promise<Provider[]> {
      let broker: BrokerLike;
      try {
        broker = await getBroker();
      } catch (err) {
        console.warn(`zg adapter: broker init failed: ${errorMessage(err)}`);
        return [];
      }
      return createZgAdapterFromBroker(broker, { fetcher }).listProviders(query);
    },

    async infer(
      provider: Provider,
      prompt: string,
    ): Promise<Result<InferenceResult, AdapterError>> {
      let broker: BrokerLike;
      try {
        broker = await getBroker();
      } catch {
        return adapterError('unavailable', 'zg adapter not configured');
      }
      return createZgAdapterFromBroker(broker, { fetcher }).infer(provider, prompt);
    },
  };
}
