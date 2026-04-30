import { describe, it, expect } from 'bun:test';
import { withStepLogging, type StepInput } from '../src/keeperhub-shim/step-handler.js';
import { withPluginMetrics } from '../src/keeperhub-shim/metrics.js';

describe('keeperhub-shim', () => {
  it('withStepLogging passes through synchronous return', async () => {
    const input: StepInput = { _context: { executionId: 'exec-1' } };
    const result = await withStepLogging(input, () => 'value');
    expect(result).toBe('value');
  });

  it('withStepLogging awaits async fn', async () => {
    const input: StepInput = {};
    const result = await withStepLogging(input, async () => {
      await Promise.resolve();
      return 42;
    });
    expect(result).toBe(42);
  });

  it('withStepLogging propagates thrown errors', async () => {
    const input: StepInput = {};
    expect(
      withStepLogging(input, () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
  });

  it('withPluginMetrics passes through with options', async () => {
    const result = await withPluginMetrics(
      { pluginName: 'p', actionName: 'a', executionId: 'e' },
      () => 'ok'
    );
    expect(result).toBe('ok');
  });

  it('withPluginMetrics awaits async inner fn', async () => {
    const result = await withPluginMetrics(
      { pluginName: 'p', actionName: 'a' },
      async () => {
        await Promise.resolve();
        return { ok: true };
      }
    );
    expect(result).toEqual({ ok: true });
  });

  it('combined nesting (the canonical step pattern)', async () => {
    const input: StepInput = { _context: { executionId: 'e' } };
    const result = await withPluginMetrics(
      { pluginName: 'p', actionName: 'a', executionId: input._context?.executionId },
      () => withStepLogging(input, () => ({ value: 7 }))
    );
    expect(result).toEqual({ value: 7 });
  });
});
