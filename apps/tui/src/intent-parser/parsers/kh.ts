import type { IntentCommand } from '../types.js';

// ── KeeperHub direct-API intents (Phase 2) ───────────────────────────
// Form: `kh <sub> [args]`. The sub-verb selects an `executeKHCall`
// shape; arg parsing is permissive — invalid args surface as
// `unknown` with a precise reason rather than a typed call (so the
// user gets immediate feedback before the dispatcher round-trips).
export function parseKh(parts: string[], trimmed: string): IntentCommand {
  const sub = parts[1]?.toLowerCase();
  if (!sub) {
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: 'kh needs a sub-verb: trigger | status | runs | cap',
    };
  }
  if (sub === 'trigger') {
    const workflowId = parts[2];
    if (!workflowId) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: 'kh trigger needs <workflowId> [<jsonInputs>]',
      };
    }
    // Inputs (optional): everything after the workflowId is rejoined
    // and parsed as JSON. We require an object at the top level so the
    // KH `inputs` payload contract holds; arrays / scalars are
    // surfaced as `unknown` with the parse error verbatim.
    let inputs: Record<string, unknown> | undefined;
    if (parts.length > 3) {
      const inputsRaw = parts.slice(3).join(' ');
      try {
        const v = JSON.parse(inputsRaw);
        if (typeof v !== 'object' || v === null || Array.isArray(v)) {
          return {
            kind: 'unknown',
            raw: trimmed,
            reason: `kh trigger inputs must be a JSON object, got ${Array.isArray(v) ? 'array' : typeof v}`,
          };
        }
        inputs = v as Record<string, unknown>;
      } catch (e) {
        return {
          kind: 'unknown',
          raw: trimmed,
          reason: `kh trigger inputs JSON parse error: ${(e as Error).message}`,
        };
      }
    }
    return { kind: 'kh-trigger', workflowId, inputs };
  }
  if (sub === 'status') {
    const executionId = parts[2];
    if (!executionId) {
      return { kind: 'unknown', raw: trimmed, reason: 'kh status needs <executionId>' };
    }
    if (parts.length > 3) {
      return { kind: 'unknown', raw: trimmed, reason: 'kh status takes exactly one argument' };
    }
    return { kind: 'kh-status', executionId };
  }
  if (sub === 'workflows') {
    if (parts.length > 2) {
      return { kind: 'unknown', raw: trimmed, reason: 'kh workflows takes no arguments' };
    }
    return { kind: 'kh-workflows' };
  }
  if (sub === 'integrations') {
    if (parts.length > 2) {
      return { kind: 'unknown', raw: trimmed, reason: 'kh integrations takes no arguments' };
    }
    return { kind: 'kh-integrations' };
  }
  if (sub === 'discover') {
    // `kh discover` (no args) → list all. `kh discover aave` → search
    // both name and description for "aave". The agent does the filter
    // client-side after pulling all 85 entries.
    const search = parts.slice(2).join(' ').trim();
    return { kind: 'kh-discover', search: search.length > 0 ? search : undefined };
  }
  if (sub === 'inspect') {
    const workflowId = parts[2];
    if (!workflowId) {
      return { kind: 'unknown', raw: trimmed, reason: 'kh inspect needs <workflowId>' };
    }
    if (parts.length > 3) {
      return { kind: 'unknown', raw: trimmed, reason: 'kh inspect takes exactly one argument' };
    }
    return { kind: 'kh-inspect', workflowId };
  }
  if (sub === 'hire') {
    // `kh hire <slugOrId> [<jsonInputs>]` — the close-the-loop x402
    // call. <slugOrId> may be the workflow's `listedSlug` (preferred,
    // since it's the actual x402 path segment) or its `id` (the
    // dispatcher resolves id → slug via `kh inspect` and refuses
    // honestly when `listedSlug === null`). Inputs are an optional
    // top-level JSON object — mirrors `kh trigger` parsing so users
    // can type `kh hire mcp-test {"address":"0x…"}`.
    const slugOrId = parts[2];
    if (!slugOrId) {
      return {
        kind: 'unknown',
        raw: trimmed,
        reason: 'kh hire needs <slugOrId> [<jsonInputs>] (e.g. "kh hire mcp-test {\\"address\\":\\"0x…\\"}")',
      };
    }
    let inputs: Record<string, unknown> | undefined;
    if (parts.length > 3) {
      const inputsRaw = parts.slice(3).join(' ');
      try {
        const v = JSON.parse(inputsRaw);
        if (typeof v !== 'object' || v === null || Array.isArray(v)) {
          return {
            kind: 'unknown',
            raw: trimmed,
            reason: `kh hire inputs must be a JSON object, got ${Array.isArray(v) ? 'array' : typeof v}`,
          };
        }
        inputs = v as Record<string, unknown>;
      } catch (e) {
        return {
          kind: 'unknown',
          raw: trimmed,
          reason: `kh hire inputs JSON parse error: ${(e as Error).message}`,
        };
      }
    }
    return { kind: 'kh-hire', slugOrId, inputs };
  }
  if (sub === 'runs' || sub === 'cap') {
    // Endpoints documented in kh-api.md but NOT deployed for kh_ bearer
    // (verified live 2026-05-02 — both 401/404 on app.keeperhub.com).
    // Surface this honestly so the operator doesn't waste time.
    return {
      kind: 'unknown',
      raw: trimmed,
      reason: `kh ${sub} — endpoint not deployed for kh_ bearer auth on app.keeperhub.com. Use 'kh workflows' or 'kh integrations' instead.`,
    };
  }
  return {
    kind: 'unknown',
    raw: trimmed,
    reason: `kh: unknown sub-verb "${sub}" — supported: discover, inspect, hire, workflows, integrations, trigger, status`,
  };
}
