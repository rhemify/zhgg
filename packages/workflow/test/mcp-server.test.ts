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

describe('createHttpHandler', () => {
  const make = async () => {
    const { buildRegistry, zgPlugin } = await loadDeps();
    const { createHttpHandler } = await import('../src/mcp-server.js');
    const registry = buildRegistry([zgPlugin]);
    return { handler: createHttpHandler({ registry, authToken: 'secret' }), registry };
  };

  it('GET /health returns 200 + tool list when registry populated', async () => {
    const { handler } = await make();
    const res = await handler(new Request('http://x/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; tools: string[] };
    expect(body.status).toBe('ok');
    expect(body.tools.length).toBeGreaterThan(0);
  });

  it('GET /health returns 503 when registry is empty', async () => {
    const { buildRegistry } = await loadDeps();
    const { createHttpHandler } = await import('../src/mcp-server.js');
    const handler = createHttpHandler({ registry: buildRegistry([]), authToken: 'secret' });
    const res = await handler(new Request('http://x/health'));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; reason: string };
    expect(body.status).toBe('unhealthy');
    expect(body.reason).toBe('no tools registered');
  });
});

describe('createHttpHandler /call auth', () => {
  /// Builds a handler bound to a single fake plugin so we can assert
  /// /call routes correctly when authorized — without standing up the real
  /// 0g-tee-inference plugin (which would try to call the live 0G router).
  const makeAuthedHandler = async () => {
    const { buildRegistry } = await loadDeps();
    const { createHttpHandler } = await import('../src/mcp-server.js');
    const stepFn = mock(async (input: { ping: string }) => ({ pong: input.ping }));
    Object.assign(stepFn, { maxRetries: 0 });
    const fakePlugin = {
      name: 'fake',
      displayName: 'Fake',
      description: 'fake',
      version: '0.0.1',
      actions: [
        {
          slug: 'echo',
          label: 'Echo',
          description: 'echoes ping',
          category: 'Test',
          stepFunction: stepFn as never,
          stepImportPath: './steps/echo',
          configFields: [{ key: 'ping', label: 'Ping', type: 'string' as const, required: true }],
          outputFields: [{ key: 'pong', label: 'Pong', type: 'string' as const }],
        },
      ],
    };
    const registry = buildRegistry([fakePlugin]);
    return { handler: createHttpHandler({ registry, authToken: 'secret' }) };
  };

  it('returns 401 when Authorization header missing', async () => {
    const { handler } = await makeAuthedHandler();
    const res = await handler(
      new Request('http://x/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'fake.echo', arguments: { ping: 'hi' } }),
      })
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when bearer token is wrong', async () => {
    const { handler } = await makeAuthedHandler();
    const res = await handler(
      new Request('http://x/call', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong-token',
        },
        body: JSON.stringify({ name: 'fake.echo', arguments: { ping: 'hi' } }),
      })
    );
    expect(res.status).toBe(401);
  });

  it('returns 200 + tool result when bearer token matches', async () => {
    const { handler } = await makeAuthedHandler();
    const res = await handler(
      new Request('http://x/call', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret',
        },
        body: JSON.stringify({ name: 'fake.echo', arguments: { ping: 'hi' } }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { pong: string } };
    expect(body.result.pong).toBe('hi');
  });

  it('returns 400 on invalid JSON body even with correct auth', async () => {
    const { handler } = await makeAuthedHandler();
    const res = await handler(
      new Request('http://x/call', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret',
        },
        body: 'not-json',
      })
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 on body missing name field', async () => {
    const { handler } = await makeAuthedHandler();
    const res = await handler(
      new Request('http://x/call', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret',
        },
        body: JSON.stringify({ arguments: { ping: 'hi' } }),
      })
    );
    expect(res.status).toBe(400);
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
