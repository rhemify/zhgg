/// oracle.zhgg.eth — regulatory + price data oracle.
///
/// Returns canned regulatory deltas keyed by topic. The price feed is a
/// placeholder for D2; D4 wires real Coinbase/Pyth integration. Each
/// query is paid for by the caller via x402 (handled OUTSIDE this module —
/// the caller wraps `queryOracle` with `verifyPayment` + `settlePayment`).

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

export type OracleResponse =
  | {
      ok: true;
      topic: OracleTopic;
      asOf: string;
      data: { kind: 'regulatory'; deltas: RegulatoryDelta[] } | { kind: 'unsupported'; reason: string };
    }
  | { ok: false; error: { kind: 'unknown_topic'; topic: string } };

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

export async function queryOracle(query: OracleQuery): Promise<OracleResponse> {
  const asOf = query.asOf ?? new Date().toISOString();

  if (query.topic === 'price') {
    return {
      ok: true,
      topic: 'price',
      asOf,
      data: { kind: 'unsupported', reason: 'Price feed integration pending (D4).' },
    };
  }

  const deltas = REGULATORY_FEED[query.topic];
  if (deltas === undefined) {
    return { ok: false, error: { kind: 'unknown_topic', topic: String(query.topic) } };
  }

  return { ok: true, topic: query.topic, asOf, data: { kind: 'regulatory', deltas } };
}
