// `import 'server-only'` (upstream KH) intentionally omitted: the npm
// package throws by design when not inside an RSC build, breaking
// `bun run src/standalone.ts`. Our runtime is bun, not Next.js — the
// guard has no analogue here. Tests mock the package inline
// (`mock.module('server-only', () => ({}))`) so both bun-run and
// bun-test paths stay green.
import { withPluginMetrics } from '@/lib/metrics/instrumentation/plugin';
import { type StepInput, withStepLogging } from '@/lib/workflow/executor/step-handler';
import { runInferenceCore, type RunInferenceOutput } from '../inference-core.js';

/// `RunInferenceStepInput` extends KeeperHub's StepInput with our action's
/// own fields. The credentials block is filled by the host runtime from
/// the credential record declared in `credentials.ts`.
export type RunInferenceStepInput = StepInput & {
  prompt: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
};

export async function runInferenceStep(
  input: RunInferenceStepInput
): Promise<RunInferenceOutput> {
  'use step';
  return withPluginMetrics(
    {
      pluginName: '0g-tee-inference',
      actionName: 'run-inference',
      executionId: input._context?.executionId,
    },
    () =>
      withStepLogging(input, () =>
        runInferenceCore({
          prompt: input.prompt,
          apiKey: input.apiKey,
          baseUrl: input.baseUrl,
          model: input.model,
        })
      )
  );
}

export const _integrationType = '0g-tee-inference';
