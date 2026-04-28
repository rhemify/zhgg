import { describe, it, expect } from 'bun:test';
import {
  InferenceIntent,
  MODES,
  OUTPUT_TYPES,
  type Mode,
  type OutputType,
} from '../src/intent.js';

describe('InferenceIntent schema', () => {
  it('parses a valid intent', () => {
    const result = InferenceIntent.safeParse({
      prompt: 'classify this headline',
      mode: 'fast',
      max_cost_usd: 0.001,
      max_latency_ms: 2000,
      output_type: 'categorical',
    });
    expect(result.success).toBe(true);
  });

  it('defaults mode to fast', () => {
    const result = InferenceIntent.safeParse({
      prompt: 'test',
      max_cost_usd: 0.001,
      max_latency_ms: 2000,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.mode).toBe('fast');
  });

  it('defaults output_type to freeform', () => {
    const result = InferenceIntent.safeParse({
      prompt: 'test',
      max_cost_usd: 0.001,
      max_latency_ms: 2000,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.output_type).toBe('freeform');
  });

  it.each([...MODES])('accepts mode=%s', (mode: Mode) => {
    const result = InferenceIntent.safeParse({
      prompt: 'test',
      mode,
      max_cost_usd: 0.001,
      max_latency_ms: 2000,
    });
    expect(result.success).toBe(true);
  });

  it.each([...OUTPUT_TYPES])('accepts output_type=%s', (output_type: OutputType) => {
    const result = InferenceIntent.safeParse({
      prompt: 'test',
      output_type,
      max_cost_usd: 0.001,
      max_latency_ms: 2000,
    });
    expect(result.success).toBe(true);
  });

  it('accepts all (mode × output_type) combinations', () => {
    for (const mode of MODES) {
      for (const output_type of OUTPUT_TYPES) {
        const result = InferenceIntent.safeParse({
          prompt: 'test',
          mode,
          output_type,
          max_cost_usd: 0.001,
          max_latency_ms: 2000,
        });
        expect(result.success).toBe(true);
      }
    }
  });

  it('rejects unknown mode', () => {
    const result = InferenceIntent.safeParse({
      prompt: 'test',
      mode: 'turbo',
      max_cost_usd: 0.001,
      max_latency_ms: 2000,
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown output_type', () => {
    const result = InferenceIntent.safeParse({
      prompt: 'test',
      output_type: 'audio',
      max_cost_usd: 0.001,
      max_latency_ms: 2000,
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty prompt', () => {
    const result = InferenceIntent.safeParse({
      prompt: '',
      max_cost_usd: 0.001,
      max_latency_ms: 2000,
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative max_cost_usd', () => {
    const result = InferenceIntent.safeParse({
      prompt: 'test',
      max_cost_usd: -1,
      max_latency_ms: 2000,
    });
    expect(result.success).toBe(false);
  });

  it('rejects zero max_latency_ms', () => {
    const result = InferenceIntent.safeParse({
      prompt: 'test',
      max_cost_usd: 0.001,
      max_latency_ms: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const result = InferenceIntent.safeParse({ prompt: 'test' });
    expect(result.success).toBe(false);
  });
});
