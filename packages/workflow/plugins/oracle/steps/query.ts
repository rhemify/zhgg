// `import 'server-only'` (upstream KH) intentionally omitted: see the
// matching note in 0g-tee-inference/steps/run-inference.ts. Tests mock
// the package; runtime has no Next.js RSC analogue.
import { withPluginMetrics } from '@/lib/metrics/instrumentation/plugin';
import { type StepInput, withStepLogging } from '@/lib/workflow/executor/step-handler';
import { queryOracle, type OracleResponse, type OracleTopic } from '@zhgg/oracle-data';

export type QueryOracleStepInput = StepInput & {
  topic: OracleTopic;
  asOf?: string;
};

export async function queryOracleStep(input: QueryOracleStepInput): Promise<OracleResponse> {
  'use step';
  return withPluginMetrics(
    {
      pluginName: 'oracle',
      actionName: 'query',
      executionId: input._context?.executionId,
    },
    () =>
      withStepLogging(input, () =>
        queryOracle({ topic: input.topic, asOf: input.asOf })
      )
  );
}

export const _integrationType = 'oracle';
