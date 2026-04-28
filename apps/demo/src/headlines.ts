import type { InferenceIntent } from '@zhgg/router';

export interface Headline {
  text: string;
  intent: Pick<InferenceIntent, 'mode' | 'output_type'> & { reason: string };
}

/**
 * 5 hardcoded crypto headlines. The first three are routine classifications
 * (fast mode). The last two would trigger on-chain consequences for an agent
 * that acts on the result, so they need TEE-attested consensus.
 */
export const HEADLINES: readonly Headline[] = [
  {
    text: 'Markets fall on tariff fears',
    intent: { mode: 'fast', output_type: 'categorical', reason: 'routine market read' },
  },
  {
    text: 'Fed holds rates, signals caution',
    intent: { mode: 'fast', output_type: 'categorical', reason: 'macro policy read' },
  },
  {
    text: 'Ethereum ETF volumes surge 40%',
    intent: { mode: 'fast', output_type: 'categorical', reason: 'flow data read' },
  },
  {
    text: 'DAO votes to allocate 500 ETH to treasury',
    intent: {
      mode: 'consensus',
      output_type: 'categorical',
      reason: 'on-chain governance consequence',
    },
  },
  {
    text: 'Smart contract upgrade proposal passes',
    intent: {
      mode: 'consensus',
      output_type: 'categorical',
      reason: 'on-chain protocol consequence',
    },
  },
] as const;
