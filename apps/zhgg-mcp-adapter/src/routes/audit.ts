/// `POST /agents/audit/call` — runs the EU AI Act audit and returns BOTH
/// the legacy probe-result AuditReport AND the canonical Slice-Y
/// `AuditReport` (the EU AI Act evidence chain a regulator would query).
///
/// The handler is deliberately thin: validate input → invoke
/// `runAuditFn` → serialize. The real-chain wiring (viem clients,
/// `inferZG`, `postReceipt`, AuditReport composition) lives in
/// `index.ts::buildAuditFnOrNull`, which is injected once at boot.
///
/// Response:
///   200  →  {
///             report: <legacy probe-result shape, bigint stringified>,
///             canonicalReport: <Slice-Y CanonicalAuditReportSchema | null>
///           }
///   400  →  { error: { kind, missing? | key?, reason } }
///   500  →  { error: { kind: 'internal_error', reason } }   // never echoes secrets
///
/// `canonicalReport` is null only when the runAuditFn implementation
/// can't produce one (legacy injectable in tests, or future agent
/// configurations). The live impl in production always returns one.

import { type AuditReport, type AuditTarget } from '@zhgg/audit-agent';
// Slice-Y canonical report — the EU AI Act evidence chain schema.
// Aliased because `@zhgg/audit-agent` also exports `AuditReport` (the
// legacy probe-result shape) — the two coexist deliberately.
import type { AuditReport as CanonicalAuditReportSchema } from '@zhgg/workflow';
import { AGENTS, validateAgentInput } from '../input-schemas.js';

const AUDIT_DESC = AGENTS.find((a) => a.id === 'audit')!;

export interface AuditCallInput {
  agentId: string;
  agentName: string;
  manifest: string;
}

/// Function shape the route depends on. Real impl wraps `runAudit` with
/// live deps AND composes the canonical AuditReport from probe evidence;
/// the test harness passes a stub that resolves synchronously.
///
/// Returning `canonicalReport: null` is acceptable (e.g. legacy
/// callers, test stubs); the live boot path always populates it.
export type RunAuditFn = (
  target: AuditTarget,
) => Promise<{
  report: AuditReport;
  canonicalReport: CanonicalAuditReportSchema | null;
}>;

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

  let result: { report: AuditReport; canonicalReport: CanonicalAuditReportSchema | null };
  try {
    result = await deps.runAuditFn(target);
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
      ...result.report,
      target: {
        ...result.report.target,
        // `bigint` doesn't survive `Response.json` — stringify to keep
        // the payload portable across KH workflows + jq pipelines.
        agentId: result.report.target.agentId.toString(),
      },
    },
    // Slice Y canonical report — the EU AI Act evidence chain. Tamper-
    // proof: keccak256 of the canonical bytes is in `anchors.feedbackHash`
    // and a regulator can re-derive it from the JSON.
    canonicalReport: result.canonicalReport,
  });
}
