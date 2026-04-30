import { describe, it, expect, mock } from 'bun:test';

// `server-only` throws outside Next.js — mock first, then dynamic-import all
// modules that transitively touch the step file. Static imports are hoisted
// before `mock.module()` runs, so they cannot be used here.
mock.module('server-only', () => ({}));

const loadDeps = async () => {
  const registry = await import('../src/registry.js');
  const plugin = await import('../plugins/0g-tee-inference/index.js');
  return { ...registry, zgPlugin: plugin.plugin };
};

describe('buildRegistry', () => {
  it('flattens plugin.actions into a tool registry keyed by plugin.action slug', async () => {
    const { buildRegistry, zgPlugin } = await loadDeps();
    const registry = buildRegistry([zgPlugin]);
    expect(registry.size).toBe(1);
    expect(registry.has('0g-tee-inference.run-inference')).toBe(true);
    const tool = registry.get('0g-tee-inference.run-inference');
    expect(tool!.pluginName).toBe('0g-tee-inference');
    expect(tool!.action.slug).toBe('run-inference');
  });

  it('handles multiple plugins', async () => {
    const { buildRegistry, zgPlugin } = await loadDeps();
    const fakePlugin = {
      ...zgPlugin,
      name: 'fake-plugin',
      actions: [{ ...zgPlugin.actions[0]!, slug: 'fake-action' }],
    };
    const registry = buildRegistry([zgPlugin, fakePlugin]);
    expect(registry.size).toBe(2);
    expect(registry.has('0g-tee-inference.run-inference')).toBe(true);
    expect(registry.has('fake-plugin.fake-action')).toBe(true);
  });
});

describe('listTools', () => {
  it('returns one MCP tool descriptor per registered action', async () => {
    const { buildRegistry, listTools, zgPlugin } = await loadDeps();
    const tools = listTools(buildRegistry([zgPlugin]));
    expect(tools.length).toBe(1);
    const t = tools[0]!;
    expect(t.name).toBe('0g-tee-inference.run-inference');
    expect(t.description).toContain('TEE Inference');
    // JSON Schema with required+properties
    expect(t.inputSchema.type).toBe('object');
    expect(Array.isArray(t.inputSchema.required)).toBe(true);
    expect(t.inputSchema.required).toContain('prompt');
    expect(t.inputSchema.properties).toHaveProperty('prompt');
    expect(t.inputSchema.properties).toHaveProperty('model');
  });
});

describe('callTool', () => {
  it('routes call to the action.stepFunction with the supplied args', async () => {
    const { buildRegistry, callTool } = await loadDeps();
    const stepFn = mock(async (input: { prompt: string }) => ({
      success: true,
      data: { response: `echoed: ${input.prompt}` },
    }));
    Object.assign(stepFn, { maxRetries: 0 });

    const fakePlugin = {
      name: 'echo',
      displayName: 'Echo',
      description: 'Echo plugin',
      version: '0.0.1',
      actions: [
        {
          slug: 'shout',
          label: 'Shout',
          description: 'returns echoed prompt',
          category: 'Test',
          stepFunction: stepFn as never,
          stepImportPath: './steps/shout',
          configFields: [{ key: 'prompt', label: 'Prompt', type: 'string' as const, required: true }],
          outputFields: [{ key: 'response', label: 'Response', type: 'string' as const }],
        },
      ],
    };

    const registry = buildRegistry([fakePlugin]);
    const result = await callTool(registry, 'echo.shout', { prompt: 'hi' });
    expect(stepFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, data: { response: 'echoed: hi' } });
  });

  it('throws on unknown tool name', async () => {
    const { buildRegistry, callTool, zgPlugin } = await loadDeps();
    const registry = buildRegistry([zgPlugin]);
    await expect(callTool(registry, 'unknown.tool', {})).rejects.toThrow(/unknown tool/i);
  });
});
