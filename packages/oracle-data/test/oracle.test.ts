import { describe, it, expect } from 'bun:test';
import { queryOracle } from '../src/index.js';

describe('queryOracle', () => {
  it('returns EU AI Act regulatory deltas with stable shape', async () => {
    const res = await queryOracle({ topic: 'eu-ai-act', asOf: '2026-04-30T00:00:00Z' });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.topic).toBe('eu-ai-act');
    expect(res.asOf).toBe('2026-04-30T00:00:00Z');
    if (res.data.kind !== 'regulatory') throw new Error('expected regulatory');
    expect(res.data.deltas.length).toBeGreaterThanOrEqual(3);
    const articles = res.data.deltas.map((d) => d.article);
    expect(articles).toContain('Article 52');
    expect(articles).toContain('Article 13');
    expect(articles).toContain('Article 6');
  });

  it('returns MiCA delta', async () => {
    const res = await queryOracle({ topic: 'mica' });
    expect(res.ok).toBe(true);
    if (!res.ok || res.data.kind !== 'regulatory') throw new Error('unreachable');
    expect(res.data.deltas[0]!.article).toBe('MiCA Title III');
  });

  it('returns GDPR delta', async () => {
    const res = await queryOracle({ topic: 'gdpr-ai' });
    expect(res.ok).toBe(true);
    if (!res.ok || res.data.kind !== 'regulatory') throw new Error('unreachable');
    expect(res.data.deltas[0]!.article).toBe('GDPR Article 22');
  });

  it('price topic returns unsupported placeholder for D2', async () => {
    const res = await queryOracle({ topic: 'price', params: { symbol: 'ETH' } });
    expect(res.ok).toBe(true);
    if (!res.ok || res.data.kind !== 'unsupported') throw new Error('unreachable');
    expect(res.data.reason).toContain('D4');
  });

  it('unknown topic returns Err unknown_topic', async () => {
    // @ts-expect-error — testing runtime behavior with invalid topic
    const res = await queryOracle({ topic: 'bogus-topic' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.kind).toBe('unknown_topic');
    expect(res.error.topic).toBe('bogus-topic');
  });
});
