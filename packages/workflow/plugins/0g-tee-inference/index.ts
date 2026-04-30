/// 0G TEE Inference plugin — KeeperHub IntegrationPlugin manifest.
///
/// Drop-in mergeable into `KeeperHub/keeperhub/plugins/0g-tee-inference/`.
/// Action steps live under `./steps/`; helpers live in `*-core.ts` files.
/// Step files MUST NOT export helpers per KeeperHub plugin spec.

import { runInferenceStep } from './steps/run-inference.js';

/// Minimal structural shape of `IntegrationPlugin` from KeeperHub. Their
/// real type adds runtime metadata; structural typing makes our shape
/// compatible when this folder is copied into their repo.
export interface ConfigField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'secret' | 'boolean';
  required?: boolean;
  default?: string | number | boolean;
  helpText?: string;
}

export interface OutputField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'object';
}

export interface Action {
  slug: string;
  label: string;
  description: string;
  category: string;
  stepFunction: ((input: unknown) => unknown) & { maxRetries?: number };
  stepImportPath: string;
  configFields: ConfigField[];
  outputFields: OutputField[];
}

export interface IntegrationPlugin {
  name: string;
  displayName: string;
  description: string;
  version: string;
  actions: Action[];
}

// Security rule: re-running an inference call double-charges the user.
// KeeperHub default retry is 3; we MUST set 0.
(runInferenceStep as Action['stepFunction']).maxRetries = 0;

export const plugin: IntegrationPlugin = {
  name: '0g-tee-inference',
  displayName: '0G TEE Inference',
  description:
    'Run LLM inference inside a 0G Compute TEE. Returns response text plus TEE attestation root for on-chain verification.',
  version: '0.1.0',
  actions: [
    {
      slug: 'run-inference',
      label: 'Run TEE Inference',
      description: 'Send a prompt to 0G Compute Router; receive verified response.',
      category: 'AI Generation',
      stepFunction: runInferenceStep as Action['stepFunction'],
      stepImportPath: './steps/run-inference',
      configFields: [
        { key: 'prompt', label: 'Prompt', type: 'string', required: true },
        {
          key: 'model',
          label: 'Model',
          type: 'string',
          default: 'qwen3.6-plus',
          helpText: 'qwen3.6-plus or glm-5-fp8',
        },
      ],
      outputFields: [
        { key: 'response', label: 'Response text', type: 'string' },
        { key: 'attestation_root', label: 'TEE attestation root', type: 'string' },
        { key: 'cost_usd', label: 'Estimated cost (USD)', type: 'number' },
        { key: 'latency_ms', label: 'Latency (ms)', type: 'number' },
        { key: 'receipt', label: 'Provider receipt id', type: 'string' },
      ],
    },
  ],
};

export const _integrationType = '0g-tee-inference';
