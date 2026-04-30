/// oracle.zhgg.eth — KeeperHub plugin manifest.
///
/// Exposes a single `query` action that returns regulatory deltas for a
/// supported topic. Data lives in `@zhgg/oracle-data` (the leaf package);
/// this folder is the drop-in mergeable KeeperHub plugin shape.

import { queryOracleStep } from './steps/query.js';
import type { Action, IntegrationPlugin } from '../../src/plugin-types.js';

export type { Action, ConfigField, IntegrationPlugin, OutputField } from '../../src/plugin-types.js';

// Idempotent reads — caller may retry safely. Default of 3 retries is fine.
// (Contrast with 0g-tee-inference's 0 retries — paid inference must not retry.)

export const plugin: IntegrationPlugin = {
  name: 'oracle',
  displayName: 'zhgg Regulatory Oracle',
  description:
    'Returns canned regulatory deltas (EU AI Act, MiCA, GDPR-AI) keyed by topic. Price feed pending D4.',
  version: '0.1.0',
  actions: [
    {
      slug: 'query',
      label: 'Query oracle',
      description: 'Fetch regulatory deltas or price data for a topic.',
      category: 'AI Generation',
      stepFunction: queryOracleStep as Action['stepFunction'],
      stepImportPath: './steps/query',
      configFields: [
        {
          key: 'topic',
          label: 'Topic',
          type: 'string',
          required: true,
          helpText: 'eu-ai-act | mica | gdpr-ai | price',
        },
        { key: 'asOf', label: 'As-of timestamp (ISO-8601)', type: 'string' },
      ],
      outputFields: [
        { key: 'topic', label: 'Topic', type: 'string' },
        { key: 'asOf', label: 'As-of timestamp', type: 'string' },
        { key: 'data', label: 'Response data', type: 'object' },
      ],
    },
  ],
};

export const _integrationType = 'oracle';
