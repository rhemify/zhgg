/// `POST /agents/oracle/call` — query the regulatory + price oracle.
///
/// Real path: imports `queryOracle` from `@zhgg/oracle-agent` (which
/// re-exports `@zhgg/oracle-data`) and calls it with the validated body.
/// For unit tests we accept an injectable `queryOracleFn` so the test
/// can return a canned response without hitting Pyth Hermes.
///
/// CRITICAL: the route MUST NOT swallow oracle errors and substitute a
/// synthetic price. The `queryOracle` contract already returns
/// `{ ok: false, error }` for transport / unknown-symbol / bad-json
/// failures; we surface those verbatim. There is no fallback branch in
/// this handler — by design.

import { queryOracle, type OracleQuery, type OracleResponse } from '@zhgg/oracle-agent';
import { AGENTS, validateAgentInput } from '../input-schemas.js';

const ORACLE_DESC = AGENTS.find((a) => a.id === 'oracle')!;

export interface OracleCallInput {
  topic: 'eu-ai-act' | 'mica' | 'gdpr-ai' | 'price';
  symbol?: string;
}

export type QueryOracleFn = (q: OracleQuery) => Promise<OracleResponse>;

export interface OracleRouteDeps {
  /// Defaults to the real `queryOracle` import. Tests inject a mock.
  queryOracleFn?: QueryOracleFn;
}

export async function handleOracleCall(
  req: Request,
  deps: OracleRouteDeps = {},
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch (e) {
    return Response.json(
      {
        error: {
          kind: 'bad_json',
          reason: e instanceof Error ? e.message : String(e),
        },
      },
      { status: 400 },
    );
  }

  const valid = validateAgentInput(body, ORACLE_DESC.inputSchema);
  if (!valid.ok) {
    return Response.json(
      {
        error: {
          kind: 'bad_input',
          ...(valid.missing !== undefined ? { missing: valid.missing } : {}),
          ...(valid.key !== undefined ? { key: valid.key } : {}),
          reason: valid.reason,
        },
      },
      { status: 400 },
    );
  }

  const input = body as OracleCallInput;
  const query: OracleQuery = {
    topic: input.topic,
    params: input.symbol ? { symbol: input.symbol } : undefined,
  };

  // Real oracle path. NO synthetic fallback branch lives here — if Pyth
  // Hermes is unreachable, `queryOracle` already returns
  // `{ ok: false, error: { kind: 'price_unavailable', ... } }` and that
  // is what we hand back to the caller, unmodified.
  const fn = deps.queryOracleFn ?? queryOracle;
  const result = await fn(query);

  if (!result.ok) {
    return Response.json(
      { error: { ...result.error } },
      { status: 502 },
    );
  }
  return Response.json({ result });
}
