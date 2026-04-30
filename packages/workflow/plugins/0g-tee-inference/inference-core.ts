/// Core logic for the 0g-tee-inference plugin's run-inference action.
///
/// Lives outside the `*-core.ts` step file by KeeperHub convention — step
/// files MUST NOT export helpers (the bundler pulls transitive deps into
/// the workflow runtime if you do). This module is freely importable.

import { inferZG, type ZGInferenceResult, type ZGRouterError, type Result } from '../../src/index.js';

export interface RunInferenceInput {
  prompt: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export type RunInferenceOutput =
  | { success: true; data: ZGInferenceResult }
  | { success: false; error: string; kind: ZGRouterError['kind'] };

export async function runInferenceCore(
  input: RunInferenceInput
): Promise<RunInferenceOutput> {
  const result: Result<ZGInferenceResult, ZGRouterError> = await inferZG(input.prompt, {
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    model: input.model,
  });

  if (!result.ok) {
    return { success: false, error: result.error.reason, kind: result.error.kind };
  }
  return { success: true, data: result.value };
}
