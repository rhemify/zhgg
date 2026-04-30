import { describe, it, expect, mock } from 'bun:test';

// `server-only` throws outside Next.js. Mock it the same way KeeperHub's own
// vitest suite does (see plugins/CLAUDE.md "Required test mocks").
mock.module('server-only', () => ({}));

describe('0g-tee-inference plugin shape', () => {
  it('plugin exports name, displayName, version, actions[]', async () => {
    const mod = await import('../plugins/0g-tee-inference/index.js');
    expect(mod._integrationType).toBe('0g-tee-inference');
    expect(mod.plugin.name).toBe('0g-tee-inference');
    expect(typeof mod.plugin.displayName).toBe('string');
    expect(typeof mod.plugin.description).toBe('string');
    expect(typeof mod.plugin.version).toBe('string');
    expect(Array.isArray(mod.plugin.actions)).toBe(true);
    expect(mod.plugin.actions.length).toBeGreaterThanOrEqual(1);
  });

  it('every action has required fields', async () => {
    const mod = await import('../plugins/0g-tee-inference/index.js');
    for (const action of mod.plugin.actions) {
      expect(typeof action.slug).toBe('string');
      expect(typeof action.label).toBe('string');
      expect(typeof action.description).toBe('string');
      expect(typeof action.category).toBe('string');
      expect(typeof action.stepFunction).toBe('function');
      expect(typeof action.stepImportPath).toBe('string');
      expect(Array.isArray(action.configFields)).toBe(true);
      expect(Array.isArray(action.outputFields)).toBe(true);
    }
  });

  it('run-inference action enforces maxRetries=0 (security rule)', async () => {
    const mod = await import('../plugins/0g-tee-inference/index.js');
    const action = mod.plugin.actions.find((a) => a.slug === 'run-inference');
    expect(action).toBeDefined();
    expect(action!.stepFunction.maxRetries).toBe(0);
  });

  it('step file exports ONLY the step function and _integrationType (no helpers)', async () => {
    const mod = await import('../plugins/0g-tee-inference/steps/run-inference.js');
    const runtimeKeys = Object.keys(mod).filter((k) => typeof mod[k as keyof typeof mod] !== 'undefined');
    // Allowed runtime exports: the step function + _integrationType.
    // Type-only exports (interfaces, types) are erased and won't appear here.
    const allowed = new Set(['runInferenceStep', '_integrationType']);
    for (const key of runtimeKeys) {
      expect(allowed.has(key)).toBe(true);
    }
  });

  it('credentials declares a 0G_ROUTER_KEY field', async () => {
    const mod = await import('../plugins/0g-tee-inference/credentials.js');
    expect(mod.credentials.name).toBe('0g-router');
    const keys = mod.credentials.fields.map((f) => f.key);
    expect(keys).toContain('apiKey');
  });
});
