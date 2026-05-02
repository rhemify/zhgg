import { describe, it, expect, mock } from 'bun:test';
import { PYTH_FEED_IDS, queryOracle, type FetchLike } from '../src/index.js';

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

  it('unknown topic returns Err unknown_topic', async () => {
    // @ts-expect-error — testing runtime behavior with invalid topic
    const res = await queryOracle({ topic: 'bogus-topic' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    if (res.error.kind !== 'unknown_topic') throw new Error('wrong kind');
    expect(res.error.topic).toBe('bogus-topic');
  });
});

describe('queryOracle — price (Pyth Hermes)', () => {
  const PYTH_HERMES_FIXTURE = (priceFields: {
    price: string;
    conf: string;
    expo: number;
    publish_time: number;
  }) => ({
    binary: { encoding: 'hex', data: ['0xdeadbeef'] },
    parsed: [
      {
        id: PYTH_FEED_IDS['ETH/USD']!,
        price: priceFields,
        ema_price: priceFields,
        metadata: { slot: 1, proof_available_time: 1, prev_publish_time: 1 },
      },
    ],
  });

  it('parses Hermes response into a PriceQuote', async () => {
    const fetchImpl = mock(
      async () =>
        new Response(
          JSON.stringify(
            PYTH_HERMES_FIXTURE({
              price: '350000000000',
              conf: '50000000',
              expo: -8,
              publish_time: 1_750_000_000,
            })
          )
        )
    ) as unknown as FetchLike;

    const res = await queryOracle(
      { topic: 'price', params: { symbol: 'ETH/USD' } },
      { fetchImpl }
    );
    expect(res.ok).toBe(true);
    if (!res.ok || res.data.kind !== 'price') throw new Error('unreachable');
    expect(res.data.quote.symbol).toBe('ETH/USD');
    expect(res.data.quote.price).toBe('350000000000');
    expect(res.data.quote.exponent).toBe(-8);
    expect(res.data.quote.publishTime).toBe(1_750_000_000);
    expect(res.data.quote.feedId).toBe(PYTH_FEED_IDS['ETH/USD']!);
  });

  it('returns price_unavailable for unknown symbol', async () => {
    const res = await queryOracle({ topic: 'price', params: { symbol: 'PENGU/USD' } });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    if (res.error.kind !== 'price_unavailable') throw new Error('wrong kind');
    expect(res.error.reason).toContain('unknown_symbol');
  });

  it('returns price_unavailable on Hermes 5xx', async () => {
    const fetchImpl = mock(
      async () => new Response('upstream error', { status: 503 })
    ) as unknown as FetchLike;
    const res = await queryOracle(
      { topic: 'price', params: { symbol: 'ETH/USD' } },
      { fetchImpl }
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    if (res.error.kind !== 'price_unavailable') throw new Error('wrong kind');
    expect(res.error.reason).toContain('503');
  });

  it('returns price_unavailable on network failure', async () => {
    const fetchImpl = mock(async () => {
      throw new Error('econnrefused');
    }) as unknown as FetchLike;
    const res = await queryOracle(
      { topic: 'price', params: { symbol: 'ETH/USD' } },
      { fetchImpl }
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    if (res.error.kind !== 'price_unavailable') throw new Error('wrong kind');
    expect(res.error.reason).toContain('econnrefused');
  });

  it('returns price_unavailable on malformed response', async () => {
    const fetchImpl = mock(
      async () => new Response(JSON.stringify({ parsed: [] }))
    ) as unknown as FetchLike;
    const res = await queryOracle(
      { topic: 'price', params: { symbol: 'ETH/USD' } },
      { fetchImpl }
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    if (res.error.kind !== 'price_unavailable') throw new Error('wrong kind');
    expect(res.error.reason).toContain('no_parsed');
  });

  it('defaults to ETH/USD when no symbol param is supplied', async () => {
    let captured: string | URL | undefined;
    const fetchImpl = mock(async (url) => {
      captured = url;
      return new Response(
        JSON.stringify(
          PYTH_HERMES_FIXTURE({
            price: '1',
            conf: '1',
            expo: -8,
            publish_time: 1,
          })
        )
      );
    }) as unknown as FetchLike;
    await queryOracle({ topic: 'price' }, { fetchImpl });
    expect(String(captured)).toContain(PYTH_FEED_IDS['ETH/USD']!);
  });
});
