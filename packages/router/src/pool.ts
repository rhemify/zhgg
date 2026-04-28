import type { InferenceAdapter } from './adapters/types.js';
import type { Provider } from './intent.js';

export interface PoolQuery {
  /**
   * If true: returned providers must have tee === true.
   * If false: providers from any adapter are eligible (tee preferred when prices tie).
   */
  teeRequired: boolean;
  maxCostUsd: number;
  maxLatencyMs: number;
  /**
   * Minimum number of providers to return (e.g. 3 for consensus mode).
   * If teeRequired === false but the caller is doing consensus, set
   * `requireOneTee: true` to ensure at least one TEE provider in the result.
   */
  count?: number;
  /**
   * For consensus mode with teeRequired=false: ensure at least one TEE
   * provider is in the returned set so 0G can attest the consensus.
   */
  requireOneTee?: boolean;
}

export interface ProviderPool {
  query(opts: PoolQuery): Promise<Provider[]>;
}

function compareProviders(a: Provider, b: Provider): number {
  if (a.price_per_call_usd !== b.price_per_call_usd) {
    return a.price_per_call_usd - b.price_per_call_usd;
  }
  if (a.latency_p50_ms !== b.latency_p50_ms) {
    return a.latency_p50_ms - b.latency_p50_ms;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function createPool(adapters: readonly InferenceAdapter[]): ProviderPool {
  return {
    async query(opts: PoolQuery): Promise<Provider[]> {
      if (adapters.length === 0) return [];

      const eligible = opts.teeRequired
        ? adapters.filter((a) => a.capabilities.tee === true)
        : adapters;
      if (eligible.length === 0) return [];

      const results = await Promise.all(
        eligible.map(async (a) => {
          try {
            return await a.listProviders({
              maxCostUsd: opts.maxCostUsd,
              maxLatencyMs: opts.maxLatencyMs,
            });
          } catch {
            return [] as Provider[];
          }
        }),
      );

      const all = results.flat();

      const filtered = all.filter(
        (p) =>
          p.price_per_call_usd <= opts.maxCostUsd &&
          p.latency_p50_ms <= opts.maxLatencyMs,
      );

      filtered.sort(compareProviders);

      if (opts.count === undefined) return filtered;

      const count = opts.count;
      const top = filtered.slice(0, count);

      if (
        opts.requireOneTee === true &&
        opts.teeRequired === false &&
        top.length > 0 &&
        !top.some((p) => p.tee === true)
      ) {
        // requireOneTee swap: when consensus needs at least one TEE provider for
        // 0G to attest the result, but the cheapest N are all non-TEE, swap the
        // most expensive non-TEE in the top-N for the cheapest TEE further down.
        // This costs at most one slot of price-optimality to gain attestability.
        // No-op if no TEE provider exists at all (best effort — caller decides).
        const cheapestTee = filtered.find((p) => p.tee === true);
        if (cheapestTee !== undefined) {
          top.pop();
          top.push(cheapestTee);
          top.sort(compareProviders);
        }
      }

      return top;
    },
  };
}
