/// Slice X — `kh hire` parser + dispatcher pre-flight tests.
///
/// We exercise:
///   1. The parser arm — `kh hire <slugOrId> [<jsonInputs>]` produces
///      `kind: 'kh-hire'` with the correct fields. JSON inputs must be
///      a top-level object (arrays / scalars / non-JSON rejected with
///      a verbatim parse error).
///   2. The dispatcher's deterministic refusal paths via the pure
///      helpers extracted into `kh-hire-validate.ts`:
///        - workflow with `listedSlug === null` → refuse honestly
///          (discoverable but not slug-callable).
///        - inputs missing a required[] key → refuse with the named
///          missing key.
///
/// The x402 round-trip itself is NOT mocked: we only test the gates
/// that fire BEFORE any wire call. Once these pass the dispatcher
/// reaches `payViaKeeperHubMarketplace`, which is exercised live (no
/// fakes) when the TUI runs against a real KH-provisioned wallet.

import { describe, it, expect } from 'bun:test';
import { parseIntent } from '../src/intent-parser.js';
import {
  resolveCallableSlug,
  validateRequiredInputs,
} from '../src/kh-hire-validate.js';
import type { KHPublicWorkflow } from 'keeperhub-agent';

// ── Fixture factory ──────────────────────────────────────────────────
//
// Mirrors the shape `/api/mcp/workflows` returns (probed live
// 2026-05-02). Defaults to a slug-callable workflow with one required
// key; tests override individual fields to exercise each refusal path.

function makeWorkflow(over: Partial<KHPublicWorkflow> = {}): KHPublicWorkflow {
  return {
    id: 'wf-test-id-0123456789',
    name: 'Test workflow',
    description: 'fixture',
    listedSlug: 'mcp-test',
    listedAt: '2026-05-02T00:00:00Z',
    priceUsdcPerCall: '0.1',
    organizationId: 'org-test',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-02T00:00:00Z',
    isListed: true,
    inputSchema: {
      type: 'object',
      required: ['address'],
      properties: { address: { type: 'string' } },
      additionalProperties: true,
    },
    ...over,
  };
}

// ── Parser tests ─────────────────────────────────────────────────────

describe('parseIntent — kh hire', () => {
  it('parses `kh hire mcp-test` into kh-hire with no inputs', () => {
    const r = parseIntent('kh hire mcp-test');
    expect(r.kind).toBe('kh-hire');
    if (r.kind !== 'kh-hire') throw new Error('discriminant');
    expect(r.slugOrId).toBe('mcp-test');
    expect(r.inputs).toBeUndefined();
  });

  it('parses `kh hire mcp-test {"address":"0xabc"}` with parsed inputs object', () => {
    const r = parseIntent('kh hire mcp-test {"address":"0xabc"}');
    expect(r.kind).toBe('kh-hire');
    if (r.kind !== 'kh-hire') throw new Error('discriminant');
    expect(r.slugOrId).toBe('mcp-test');
    expect(r.inputs).toEqual({ address: '0xabc' });
  });

  it('parses `kh hire <opaque-id>` (id rather than slug) — dispatcher resolves later', () => {
    const id = 'cmf3v9oym000208l51rvabcde';
    const r = parseIntent(`kh hire ${id}`);
    expect(r.kind).toBe('kh-hire');
    if (r.kind !== 'kh-hire') throw new Error('discriminant');
    expect(r.slugOrId).toBe(id);
  });

  it('rejects `kh hire` with no target', () => {
    const r = parseIntent('kh hire');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') throw new Error('discriminant');
    expect(r.reason).toMatch(/needs <slugOrId>/);
  });

  it('rejects array JSON inputs (must be top-level object)', () => {
    const r = parseIntent('kh hire mcp-test [1,2,3]');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') throw new Error('discriminant');
    expect(r.reason).toMatch(/must be a JSON object, got array/);
  });

  it('rejects scalar JSON inputs', () => {
    const r = parseIntent('kh hire mcp-test 42');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') throw new Error('discriminant');
    expect(r.reason).toMatch(/must be a JSON object, got number/);
  });

  it('rejects malformed JSON with the parser error verbatim', () => {
    const r = parseIntent('kh hire mcp-test {address:bad}');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') throw new Error('discriminant');
    expect(r.reason).toMatch(/JSON parse error:/);
  });
});

// ── Dispatcher pre-flight tests (pure helpers) ───────────────────────

describe('dispatchKHHireIntent — refuses on null listedSlug', () => {
  it('returns no-slug refusal when the matched workflow has listedSlug === null', () => {
    const wf = makeWorkflow({ listedSlug: null });
    const r = resolveCallableSlug(wf);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected refusal');
    expect(r.kind).toBe('no-slug');
    expect(r.workflowId).toBe(wf.id);
  });

  it('returns the slug when listedSlug is non-null', () => {
    const wf = makeWorkflow({ listedSlug: 'mcp-test' });
    const r = resolveCallableSlug(wf);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected resolution');
    expect(r.slug).toBe('mcp-test');
  });
});

describe('dispatchKHHireIntent — refuses on missing required input keys', () => {
  it('returns the named missing key when inputs lack a required field', () => {
    const wf = makeWorkflow({
      inputSchema: { required: ['address', 'chainId'], properties: {} },
    });
    const r = validateRequiredInputs(wf, { address: '0xabc' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected refusal');
    expect(r.missing).toBe('chainId');
    expect(r.required).toEqual(['address', 'chainId']);
  });

  it('returns ok when all required keys are present', () => {
    const wf = makeWorkflow({
      inputSchema: { required: ['address'], properties: {} },
    });
    const r = validateRequiredInputs(wf, { address: '0xabc' });
    expect(r.ok).toBe(true);
  });

  it('returns ok when the schema has no required[] (workflow takes no params)', () => {
    const wf = makeWorkflow({ inputSchema: { properties: {} } });
    const r = validateRequiredInputs(wf, undefined);
    expect(r.ok).toBe(true);
  });

  it('refuses when required keys exist but inputs is undefined', () => {
    const wf = makeWorkflow({
      inputSchema: { required: ['address'], properties: {} },
    });
    const r = validateRequiredInputs(wf, undefined);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected refusal');
    expect(r.missing).toBe('address');
  });
});
