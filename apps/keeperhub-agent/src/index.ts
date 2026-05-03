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
import { listWorkflows, type KHWorkflowSummary } from './endpoints/list-workflows.js';
import { listIntegrations, type KHIntegrationSummary } from './endpoints/list-integrations.js';
import {
  discoverWorkflows,
  inspectWorkflow,
  type DiscoverFilters,
  type KHPublicWorkflow,
} from './endpoints/discover.js';
import type { KHWorkflowExecution } from './types.js';

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

// Empirical surface: only the four below are deployed for `kh_` bearers
// on `app.keeperhub.com`. The previously-documented `/api/analytics/*`,
// `/api/runs`, and `/api/me` endpoints either 404 or 401 with a real
// org key — they're session-only or aspirational. Probed live 2026-05-02.
export type KHCall =
  | { kind: 'workflow_trigger'; workflowId: string; inputs?: Record<string, unknown> }
  | { kind: 'workflow_status'; executionId: string }
  | { kind: 'list_workflows' }
  | { kind: 'list_integrations' }
  | { kind: 'discover'; filters?: DiscoverFilters }
  | { kind: 'inspect'; workflowId: string };

export type KHCallResult =
  | { kind: 'workflow_trigger'; value: KHWorkflowExecution }
  | { kind: 'workflow_status'; value: KHWorkflowExecution }
  | { kind: 'list_workflows'; value: KHWorkflowSummary[] }
  | { kind: 'list_integrations'; value: KHIntegrationSummary[] }
  | { kind: 'discover'; value: KHPublicWorkflow[] }
  | { kind: 'inspect'; value: KHPublicWorkflow | null };

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
    case 'list_workflows': {
      const r = await listWorkflows(client);
      if (!r.ok) return r;
      return { ok: true, value: { kind: 'list_workflows', value: r.value } };
    }
    case 'list_integrations': {
      const r = await listIntegrations(client);
      if (!r.ok) return r;
      return { ok: true, value: { kind: 'list_integrations', value: r.value } };
    }
    case 'discover': {
      const r = await discoverWorkflows(client, call.filters);
      if (!r.ok) return r;
      return { ok: true, value: { kind: 'discover', value: r.value } };
    }
    case 'inspect': {
      const r = await inspectWorkflow(client, call.workflowId);
      if (!r.ok) return r;
      return { ok: true, value: { kind: 'inspect', value: r.value } };
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
  // Treat empty string the same as unset — `??` lets "" through, which
  // produces an invalid URL like "/api/workflows" that fetch rejects.
  const baseUrl =
    env.KEEPERHUB_API_URL && env.KEEPERHUB_API_URL.length > 0
      ? env.KEEPERHUB_API_URL
      : KH_DEFAULT_BASE_URL;
  return {
    ok: true,
    value: createKHClient({ apiKey, baseUrl, fetchImpl: opts.fetchImpl }),
  };
}

// ─── Re-exports for downstream consumers ─────────────────────────────────
//
// `keeperhub-agent/client` and `keeperhub-agent/types` remain granular
// subpaths; the re-exports below let barrel consumers reach the full
// public surface (client factory + endpoint helpers + types) from the
// package root.

export { createKHClient, KH_DEFAULT_BASE_URL } from './client.js';
export type {
  KHClient,
  KHClientConfig,
  KHFetch,
  KHFetchInit,
  KHFetchResponse,
} from './client.js';
export type {
  KHWorkflowExecution,
  KHWorkflowStep,
  KHWorkflowStatus,
} from './types.js';
export { listWorkflows } from './endpoints/list-workflows.js';
export type { KHWorkflowSummary } from './endpoints/list-workflows.js';
export { listIntegrations } from './endpoints/list-integrations.js';
export type { KHIntegrationSummary, KHIntegrationType } from './endpoints/list-integrations.js';
export { discoverWorkflows, inspectWorkflow } from './endpoints/discover.js';
export type { KHPublicWorkflow, DiscoverFilters } from './endpoints/discover.js';
export { triggerWorkflow } from './endpoints/workflow-trigger.js';
export type { TriggerArgs } from './endpoints/workflow-trigger.js';
export { getWorkflowStatus } from './endpoints/workflow-status.js';

// ─── CLI entrypoint (one-shot) ───────────────────────────────────────────

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  if (!sub) {
    console.error('usage: bun run keeperhub-agent <trigger|status|workflows|integrations> [args]');
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
  } else if (sub === 'workflows') {
    call = { kind: 'list_workflows' };
  } else if (sub === 'integrations') {
    call = { kind: 'list_integrations' };
  } else if (sub === 'discover') {
    const search = rest.join(' ').trim() || undefined;
    call = { kind: 'discover', filters: search ? { search } : undefined };
  } else if (sub === 'inspect') {
    const [workflowId] = rest;
    if (!workflowId) {
      console.error('usage: bun run keeperhub-agent inspect <workflowId>');
      process.exit(2);
    }
    call = { kind: 'inspect', workflowId };
  } else {
    console.error(`unknown subcommand: ${sub} — try trigger|status|workflows|integrations|discover|inspect`);
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
