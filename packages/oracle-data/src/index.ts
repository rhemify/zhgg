/// oracle.zhgg.eth — regulatory + price data oracle.
///
/// Two backends:
///   - Regulatory deltas (EU AI Act, MiCA, GDPR-AI) — canned + curated
///     by zhgg ops. Versioned per `effectiveDate` so consumers can
///     check freshness.
///   - Price feed — real **Pyth Hermes** pull-oracle fetch
///     (https://hermes.pyth.network). Returns the latest published
///     `(price, conf, exponent, publish_time)` for a Pyth feed id.
///
/// Each query is paid for by the caller via x402 (handled OUTSIDE this
/// module — the caller wraps `queryOracle` with `verifyPayment` +
/// `settlePayment`).

export type OracleTopic = 'eu-ai-act' | 'mica' | 'gdpr-ai' | 'price';

export interface OracleQuery {
  topic: OracleTopic;
  /// Free-form parameters (e.g. asset symbol for price queries).
  params?: Record<string, unknown>;
  /// ISO-8601 — defaults to now. Lets tests pin time for golden hashes.
  asOf?: string;
}

export interface RegulatoryDelta {
  article: string;
  effectiveDate: string;
  summary: string;
}

export interface PriceQuote {
  /// Pyth feed id, hex string. e.g. ETH/USD = `0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace`.
  feedId: string;
  /// Symbol the user requested (BTC/USD, ETH/USD, USDC/USD, etc.).
  symbol: string;
  /// Integer price scaled by 10^exponent. Pyth always returns a signed
  /// 64-bit price so consumers must apply the exponent themselves.
  price: string;
  /// Confidence interval (one-sigma). Same scale as `price`.
  confidence: string;
  /// 10^exponent multiplier. ETH/USD typical: -8 → divide by 1e8.
  exponent: number;
  /// Publish time (unix seconds) the price was attested by Pyth.
  publishTime: number;
}

export type OracleResponse =
  | {
      ok: true;
      topic: OracleTopic;
      asOf: string;
      data:
        | { kind: 'regulatory'; deltas: RegulatoryDelta[] }
        | { kind: 'price'; quote: PriceQuote }
        | { kind: 'unsupported'; reason: string };
    }
  | { ok: false; error: { kind: 'unknown_topic'; topic: string } | { kind: 'price_unavailable'; reason: string } };

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

/// Pyth feed IDs for the symbols zhgg agents typically reference.
/// Source: https://pyth.network/developers/price-feed-ids
export const PYTH_FEED_IDS: Record<string, string> = {
  'BTC/USD':  '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  'ETH/USD':  '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  'USDC/USD': '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
  'SOL/USD':  '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  'USDT/USD': '0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
};

const PYTH_HERMES_DEFAULT = 'https://hermes.pyth.network';

export interface QueryOracleOptions {
  /// Override Pyth Hermes endpoint (tests pass a stub).
  pythHermesUrl?: string;
  /// Pluggable fetch — default is global `fetch`.
  fetchImpl?: FetchLike;
}

const REGULATORY_FEED: Record<Exclude<OracleTopic, 'price'>, RegulatoryDelta[]> = {
  'eu-ai-act': [
    {
      article: 'Article 6',
      effectiveDate: '2026-08-02',
      summary:
        'High-risk AI systems must complete conformity assessment before deployment in the EU.',
    },
    {
      article: 'Article 13',
      effectiveDate: '2026-08-02',
      summary:
        'Providers must furnish users with clear information on capabilities, limitations, and data sources.',
    },
    {
      article: 'Article 52',
      effectiveDate: '2026-08-02',
      summary:
        'Agents that interact with humans must clearly disclose that the user is engaging with an AI.',
    },
  ],
  mica: [
    {
      article: 'MiCA Title III',
      effectiveDate: '2024-12-30',
      summary:
        'Asset-referenced token issuers must obtain authorisation and publish a white paper before offering ART in the EU.',
    },
  ],
  'gdpr-ai': [
    {
      article: 'GDPR Article 22',
      effectiveDate: '2018-05-25',
      summary:
        'Decisions based solely on automated processing producing legal or similarly significant effects on a data subject require explicit safeguards.',
    },
  ],
};

export async function queryOracle(
  query: OracleQuery,
  opts: QueryOracleOptions = {}
): Promise<OracleResponse> {
  const asOf = query.asOf ?? new Date().toISOString();

  if (query.topic === 'price') {
    return queryPrice(query, asOf, opts);
  }

  const deltas = REGULATORY_FEED[query.topic];
  if (deltas === undefined) {
    return { ok: false, error: { kind: 'unknown_topic', topic: String(query.topic) } };
  }

  return { ok: true, topic: query.topic, asOf, data: { kind: 'regulatory', deltas } };
}

/// Fetch the latest Pyth Hermes price for a symbol. Hermes endpoint:
///   GET /v2/updates/price/latest?ids[]=<feed_id>&parsed=true
/// Response shape:
///   { binary: { ... }, parsed: [{ id, price: { price, conf, expo, publish_time } }] }
async function queryPrice(
  query: OracleQuery,
  asOf: string,
  opts: QueryOracleOptions
): Promise<OracleResponse> {
  const symbol =
    typeof query.params?.symbol === 'string' ? query.params.symbol : 'ETH/USD';
  const feedId = PYTH_FEED_IDS[symbol];
  if (!feedId) {
    return {
      ok: false,
      error: { kind: 'price_unavailable', reason: `unknown_symbol: ${symbol}` },
    };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.pythHermesUrl ?? PYTH_HERMES_DEFAULT;
  const url = `${baseUrl}/v2/updates/price/latest?ids[]=${feedId}&parsed=true`;

  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (e) {
    return {
      ok: false,
      error: {
        kind: 'price_unavailable',
        reason: `transport: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: { kind: 'price_unavailable', reason: `Hermes HTTP ${res.status}` },
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    return {
      ok: false,
      error: {
        kind: 'price_unavailable',
        reason: `bad_json: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }

  const parsed = (body as { parsed?: unknown }).parsed;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, error: { kind: 'price_unavailable', reason: 'no_parsed_in_response' } };
  }

  const first = parsed[0] as {
    id?: unknown;
    price?: { price?: unknown; conf?: unknown; expo?: unknown; publish_time?: unknown };
  };
  const priceObj = first?.price;
  if (
    !priceObj ||
    typeof priceObj.price !== 'string' ||
    typeof priceObj.conf !== 'string' ||
    typeof priceObj.expo !== 'number' ||
    typeof priceObj.publish_time !== 'number'
  ) {
    return {
      ok: false,
      error: { kind: 'price_unavailable', reason: 'missing_price_fields' },
    };
  }

  return {
    ok: true,
    topic: 'price',
    asOf,
    data: {
      kind: 'price',
      quote: {
        feedId,
        symbol,
        price: priceObj.price,
        confidence: priceObj.conf,
        exponent: priceObj.expo,
        publishTime: priceObj.publish_time,
      },
    },
  };
}
