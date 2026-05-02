/// `POST /agents/audit/call` — runs the EU AI Act audit and returns the
/// AuditReport JSON.
///
/// The handler is deliberately thin: validate input → invoke
/// `runAuditFn` → serialize. The real-chain wiring (viem clients,
/// `inferZG`, `postReceipt`) lives in `server.ts::buildLiveAuditFn`,
/// which is injected once at boot. Tests inject a lambda returning a
/// canned AuditReport — the handler treats both the same way.
///
/// Response:
///   200  →  { report: AuditReport (bigint agentId stringified) }
///   400  →  { error: { kind, missing? | key?, reason } }
///   500  →  { error: { kind: 'internal_error', reason } }   // never echoes secrets

import { runAudit, type AuditReport, type AuditTarget } from '@zhgg/audit-agent';
import { AGENTS, validateAgentInput } from '../input-schemas.js';

const AUDIT_DESC = AGENTS.find((a) => a.id === 'audit')!;

export interface AuditCallInput {
  agentId: string;
  agentName: string;
  manifest: string;
}

/// Function shape the route depends on. Real impl wraps `runAudit` with
/// live deps; the test harness passes a stub that resolves to a canned
/// AuditReport synchronously.
export type RunAuditFn = (
  target: AuditTarget,
) => Promise<AuditReport>;

export interface AuditRouteDeps {
  runAuditFn: RunAuditFn;
}

export async function handleAuditCall(
  req: Request,
  deps: AuditRouteDeps,
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

  const valid = validateAgentInput(body, AUDIT_DESC.inputSchema);
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

  const input = body as AuditCallInput;

  let agentIdBig: bigint;
  try {
    agentIdBig = BigInt(input.agentId);
  } catch (e) {
    return Response.json(
      {
        error: {
          kind: 'bad_input',
          key: 'agentId',
          reason: `agentId must parse as bigint: ${e instanceof Error ? e.message : String(e)}`,
        },
      },
      { status: 400 },
    );
  }

  const target: AuditTarget = {
    agentId: agentIdBig,
    agentName: input.agentName,
    manifest: input.manifest,
  };

  let report: AuditReport;
  try {
    report = await deps.runAuditFn(target);
  } catch (e) {
    return Response.json(
      {
        error: {
          kind: 'internal_error',
          reason: e instanceof Error ? e.message : String(e),
        },
      },
      { status: 500 },
    );
  }

  return Response.json({
    report: {
      ...report,
      target: {
        ...report.target,
        // `bigint` doesn't survive `Response.json` — stringify to keep
        // the payload portable across KH workflows + jq pipelines.
        agentId: report.target.agentId.toString(),
      },
    },
  });
}
