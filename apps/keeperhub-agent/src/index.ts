/// Direct KeeperHub API executor — used by the TUI's `kh ...` intents.
///
/// HARD RULES (mirrors swap-agent / transfer-agent):
///   - NEVER log or echo `KH_API_KEY`. The bearer leak is the only way
///     this becomes a security incident, so the key is read once via
///     `buildKHFromEnv()`, threaded into the client constructor, and
///     never returned to a caller. No error message references it by
///     value.
///   - If `KH_API_KEY` is missing or doesn't start with the documented
///     `kh_` prefix → return `{ ok: false, error: { kind: 'env_missing' } }`.
///     Same shape the swap-agent uses for its named-key check.
///   - Errors from KH (4xx/5xx, network, malformed JSON) bubble
///     verbatim. The TUI prints `kind`/`status`/`reason` exactly as
///     produced — no synthetic success layer.
///
/// The exported `executeKHCall(call)` is a thin discriminated-union
/// dispatcher: each `kind` maps to one endpoint helper. The TUI builds
/// the call object from `parseIntent()` output; the CLI at the bottom
/// is a one-shot for shell testing.

import {
  createKHClient,
  KH_DEFAULT_BASE_URL,
  type KHClient,
  type KHFetch,
} from './client.js';
import { triggerWorkflow } from './endpoints/workflow-trigger.js';
import { getWorkflowStatus } from './endpoints/workflow-status.js';
import { getAnalyticsRuns, type RunRangeFilter, type RunStatusFilter } from './endpoints/analytics-runs.js';
import { getSpendCap } from './endpoints/spend-cap.js';
import type {
  KHAnalyticsRun,
  KHSpendCap,
  KHWorkflowExecution,
} from './types.js';

// ─── Result + error envelope ─────────────────────────────────────────────

/// Discriminated error kinds. `unauthorized`/`not_found`/`unprocessable`
/// /`server_error` are mapped from HTTP status by the client; everything
/// else is a local validation/parse failure.
export type KHErrorKind =
  | 'env_missing'
  | 'bad_request'
  | 'network'
  | 'unauthorized'
  | 'not_found'
  | 'unprocessable'
  | 'server_error'
  | 'http_error'
  | 'malformed_response';

export interface KHError {
  kind: KHErrorKind;
  reason: string;
  /// HTTP status when the error came from the wire. Absent for local
  /// validation errors and fetch-throws.
  status?: number;
}

export type KHResult<T> = { ok: true; value: T } | { ok: false; error: KHError };

// ─── Discriminated call shape ────────────────────────────────────────────
//
// One union per supported intent. Adding a new endpoint = one extra arm
// here + one extra case in the switch below.

export type KHCall =
  | { kind: 'workflow_trigger'; workflowId: string; inputs?: Record<string, unknown> }
  | { kind: 'workflow_status'; executionId: string }
  | { kind: 'analytics_runs'; status?: RunStatusFilter; range?: RunRangeFilter }
  | { kind: 'spend_cap' };

export type KHCallResult =
  | { kind: 'workflow_trigger'; value: KHWorkflowExecution }
  | { kind: 'workflow_status'; value: KHWorkflowExecution }
  | { kind: 'analytics_runs'; value: KHAnalyticsRun[] }
  | { kind: 'spend_cap'; value: KHSpendCap };

// ─── Public API ──────────────────────────────────────────────────────────

export interface ExecuteOpts {
  /// Override the client (test harness). When omitted we build one from
  /// `process.env` via `buildKHFromEnv()`.
  client?: KHClient;
  /// Override `process.env`. Used by the test harness to flip
  /// `KH_API_KEY` per-test.
  env?: NodeJS.ProcessEnv;
}

export async function executeKHCall(
  call: KHCall,
  opts: ExecuteOpts = {},
): Promise<KHResult<KHCallResult>> {
  let client = opts.client;
  if (!client) {
    const built = buildKHFromEnv(opts.env ?? process.env);
    if (!built.ok) return built;
    client = built.value;
  }

  switch (call.kind) {
    case 'workflow_trigger': {
      const r = await triggerWorkflow(client, {
        workflowId: call.workflowId,
        inputs: call.inputs,
      });
      if (!r.ok) return r;
      return { ok: true, value: { kind: 'workflow_trigger', value: r.value } };
    }
    case 'workflow_status': {
      const r = await getWorkflowStatus(client, call.executionId);
      if (!r.ok) return r;
      return { ok: true, value: { kind: 'workflow_status', value: r.value } };
    }
    case 'analytics_runs': {
      const r = await getAnalyticsRuns(client, { status: call.status, range: call.range });
      if (!r.ok) return r;
      return { ok: true, value: { kind: 'analytics_runs', value: r.value } };
    }
    case 'spend_cap': {
      const r = await getSpendCap(client);
      if (!r.ok) return r;
      return { ok: true, value: { kind: 'spend_cap', value: r.value } };
    }
  }
}

// ─── Env wiring ──────────────────────────────────────────────────────────

export interface BuildKHOpts {
  /// Substitute fetch (used by the test harness).
  fetchImpl?: KHFetch;
}

/// Build a client from env. Returns the typed env_missing error so
/// callers can render it directly. NEVER includes the key value in the
/// returned reason — only the env-var name.
export function buildKHFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: BuildKHOpts = {},
): KHResult<KHClient> {
  const apiKey = env.KH_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    return {
      ok: false,
      error: {
        kind: 'env_missing',
        reason: 'KH_API_KEY is unset — paste your kh_… key into .env (NEVER commit it)',
      },
    };
  }
  if (!apiKey.startsWith('kh_')) {
    return {
      ok: false,
      error: {
        kind: 'env_missing',
        reason: 'KH_API_KEY does not start with "kh_" — direct API requires an org-level key (wfb_ keys are webhook-only)',
      },
    };
  }
  const baseUrl = env.KEEPERHUB_API_URL ?? KH_DEFAULT_BASE_URL;
  return {
    ok: true,
    value: createKHClient({ apiKey, baseUrl, fetchImpl: opts.fetchImpl }),
  };
}

// ─── Re-exports for downstream consumers ─────────────────────────────────

export type { KHClient, KHFetch } from './client.js';
export { KH_DEFAULT_BASE_URL } from './client.js';
export type {
  KHAnalyticsRun,
  KHSpendCap,
  KHWorkflowExecution,
  KHWorkflowStep,
  KHWorkflowStatus,
} from './types.js';
export type { RunRangeFilter, RunStatusFilter } from './endpoints/analytics-runs.js';

// ─── CLI entrypoint (one-shot) ───────────────────────────────────────────

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  if (!sub) {
    console.error('usage: bun run keeperhub-agent <trigger|status|runs|cap> [args]');
    process.exit(2);
  }

  let call: KHCall;
  if (sub === 'trigger') {
    const [workflowId, inputsJson] = rest;
    if (!workflowId) {
      console.error('usage: bun run keeperhub-agent trigger <workflowId> [<jsonInputs>]');
      process.exit(2);
    }
    let inputs: Record<string, unknown> | undefined;
    if (inputsJson) {
      try {
        const v = JSON.parse(inputsJson);
        if (typeof v !== 'object' || v === null || Array.isArray(v)) {
          throw new Error('inputs must be a JSON object');
        }
        inputs = v as Record<string, unknown>;
      } catch (e) {
        console.error(`inputs parse error: ${(e as Error).message}`);
        process.exit(2);
      }
    }
    call = { kind: 'workflow_trigger', workflowId, inputs };
  } else if (sub === 'status') {
    const [executionId] = rest;
    if (!executionId) {
      console.error('usage: bun run keeperhub-agent status <executionId>');
      process.exit(2);
    }
    call = { kind: 'workflow_status', executionId };
  } else if (sub === 'runs') {
    const status = rest[0] as RunStatusFilter | undefined;
    const range = rest[1] as RunRangeFilter | undefined;
    call = { kind: 'analytics_runs', status, range };
  } else if (sub === 'cap') {
    call = { kind: 'spend_cap' };
  } else {
    console.error(`unknown subcommand: ${sub}`);
    process.exit(2);
  }

  const result = await executeKHCall(call);
  if (!result.ok) {
    const e = result.error;
    console.error(`kh ${sub} failed: ${e.kind}${e.status ? ` (HTTP ${e.status})` : ''} — ${e.reason}`);
    process.exit(1);
  }
  console.log(JSON.stringify(result.value, null, 2));
}

if (import.meta.main) {
  void main();
}
