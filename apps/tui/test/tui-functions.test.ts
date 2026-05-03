/// Comprehensive unit tests for the TUI pure/logic modules.
///
/// Covers:
///   1. parseIntent — every intent kind
///   2. format helpers — pad, shortHash, formatStaged
///   3. agent-status — liveAgents(), agentStatus()
///   4. orchestrator-step — applyOrchestratorStep
///   5. flow-state — mkFlow

import { describe, it, expect, beforeEach } from 'bun:test';

import { parseIntent } from '../src/intent-parser.js';
import { pad, shortHash, formatStaged } from '../src/format.js';
import { liveAgents, agentStatus } from '../src/agent-status.js';
import { applyOrchestratorStep } from '../src/orchestrator-step.js';
import { mkFlow } from '../src/flow-state.js';
import { AUDIT } from '../src/audit-trail.js';
import type { OrchestratorStepEnv } from '../src/orchestrator-step.js';
import type { ReceiptEnvelope } from '../src/receipt-feed.js';
import type { FlowState } from '../src/flow-state.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Build a minimal OrchestratorStepEnv with no-op callbacks and a fresh flow.
function mkEnv(flow?: FlowState): OrchestratorStepEnv & { flow: FlowState } {
  let _receipt: ReceiptEnvelope = { status: 'no settlement yet' };
  const f = flow ?? mkFlow();
  return {
    flow: f,
    setReceiptEnvelope: (e) => { _receipt = e; },
    getReceiptEnvelope: () => _receipt,
    setToast: () => {},
  };
}

/// Clear the module-scope AUDIT ring buffer before tests that check it
/// so prior test runs don't leak rows. (applyOrchestratorStep pushes to AUDIT
/// as a side-effect.)
function clearAudit() {
  AUDIT.splice(0, AUDIT.length);
}

// ── 1. Intent parser ─────────────────────────────────────────────────────────

describe('parseIntent — empty + unknown', () => {
  it('empty string → { kind: "empty" }', () => {
    expect(parseIntent('').kind).toBe('empty');
  });

  it('whitespace-only string → { kind: "empty" }', () => {
    expect(parseIntent('   ').kind).toBe('empty');
  });

  it('unknown command → { kind: "unknown" }', () => {
    const r = parseIntent('foobar baz');
    expect(r.kind).toBe('unknown');
  });
});

describe('parseIntent — audit', () => {
  it('audit 1 → tokenId 1n, topic eu-ai-act (default)', () => {
    const r = parseIntent('audit 1');
    expect(r.kind).toBe('audit');
    if (r.kind !== 'audit') throw new Error('discriminant');
    expect(r.tokenId).toBe(1n);
    expect(r.topic).toBe('eu-ai-act');
  });

  it('audit 1 mica → topic mica', () => {
    const r = parseIntent('audit 1 mica');
    expect(r.kind).toBe('audit');
    if (r.kind !== 'audit') throw new Error('discriminant');
    expect(r.topic).toBe('mica');
  });

  it('audit 1 gdpr-ai → topic gdpr-ai', () => {
    const r = parseIntent('audit 1 gdpr-ai');
    expect(r.kind).toBe('audit');
    if (r.kind !== 'audit') throw new Error('discriminant');
    expect(r.topic).toBe('gdpr-ai');
  });

  it('audit 1 price → topic price', () => {
    const r = parseIntent('audit 1 price');
    expect(r.kind).toBe('audit');
    if (r.kind !== 'audit') throw new Error('discriminant');
    expect(r.topic).toBe('price');
  });

  it('audit 1 invalid-topic → falls back to eu-ai-act', () => {
    const r = parseIntent('audit 1 invalid-topic');
    expect(r.kind).toBe('audit');
    if (r.kind !== 'audit') throw new Error('discriminant');
    expect(r.topic).toBe('eu-ai-act');
  });

  it('audit oracle.zhgg.eth → resolves to tokenId 2n', () => {
    const r = parseIntent('audit oracle.zhgg.eth');
    expect(r.kind).toBe('audit');
    if (r.kind !== 'audit') throw new Error('discriminant');
    expect(r.tokenId).toBe(2n);
    expect(r.target).toBe('oracle.zhgg.eth');
  });

  it('audit (no target) → { kind: "unknown" }', () => {
    const r = parseIntent('audit');
    expect(r.kind).toBe('unknown');
  });

  it('audit with unregistered ENS → { kind: "unknown_agent" }', () => {
    const r = parseIntent('audit unknown-agent.zhgg.eth');
    expect(r.kind).toBe('unknown_agent');
  });
});

describe('parseIntent — ask-oracle', () => {
  it('ask oracle ETH/USD → ask-oracle with topic price', () => {
    const r = parseIntent('ask oracle ETH/USD');
    expect(r.kind).toBe('ask-oracle');
    if (r.kind !== 'ask-oracle') throw new Error('discriminant');
    expect(r.topic).toBe('price');
    expect(r.raw).toBe('ETH/USD');
  });

  it('ask oracle eu-ai-act → ask-oracle with topic eu-ai-act', () => {
    const r = parseIntent('ask oracle eu-ai-act');
    expect(r.kind).toBe('ask-oracle');
    if (r.kind !== 'ask-oracle') throw new Error('discriminant');
    expect(r.topic).toBe('eu-ai-act');
  });

  it('ask oracle mica → ask-oracle with topic mica', () => {
    const r = parseIntent('ask oracle mica');
    expect(r.kind).toBe('ask-oracle');
    if (r.kind !== 'ask-oracle') throw new Error('discriminant');
    expect(r.topic).toBe('mica');
  });

  it('ask oracle (no topic) → unknown', () => {
    const r = parseIntent('ask oracle');
    expect(r.kind).toBe('unknown');
  });
});

describe('parseIntent — swap', () => {
  it('swap 10 USDC to WETH → swap intent', () => {
    const r = parseIntent('swap 10 USDC to WETH');
    expect(r.kind).toBe('swap');
    if (r.kind !== 'swap') throw new Error('discriminant');
    expect(r.amount).toBe('10');
    expect(r.fromSym).toBe('USDC');
    expect(r.toSym).toBe('WETH');
  });

  it('swap 0.001 ETH to USDC → swap intent', () => {
    const r = parseIntent('swap 0.001 ETH to USDC');
    expect(r.kind).toBe('swap');
    if (r.kind !== 'swap') throw new Error('discriminant');
    expect(r.amount).toBe('0.001');
    expect(r.fromSym).toBe('ETH');
    expect(r.toSym).toBe('USDC');
  });

  it('swap without "to" keyword (compact) → swap intent', () => {
    const r = parseIntent('swap 5 WETH USDC');
    expect(r.kind).toBe('swap');
    if (r.kind !== 'swap') throw new Error('discriminant');
    expect(r.fromSym).toBe('WETH');
    expect(r.toSym).toBe('USDC');
  });

  it('swap same-to-same → unknown', () => {
    const r = parseIntent('swap 5 USDC USDC');
    expect(r.kind).toBe('unknown');
  });

  it('swap unsupported symbol → unknown', () => {
    const r = parseIntent('swap 5 BTC USDC');
    expect(r.kind).toBe('unknown');
  });
});

describe('parseIntent — transfer', () => {
  it('transfer 5 USDC to 0x-address → transfer intent', () => {
    const r = parseIntent('transfer 5 USDC to 0x1234567890123456789012345678901234567890');
    expect(r.kind).toBe('transfer');
    if (r.kind !== 'transfer') throw new Error('discriminant');
    expect(r.amount).toBe('5');
    expect(r.symbol).toBe('USDC');
    expect(r.recipient).toBe('0x1234567890123456789012345678901234567890');
  });

  it('transfer 0.1 ETH to ENS name → transfer intent', () => {
    const r = parseIntent('transfer 0.1 ETH to vitalik.eth');
    expect(r.kind).toBe('transfer');
    if (r.kind !== 'transfer') throw new Error('discriminant');
    expect(r.amount).toBe('0.1');
    expect(r.symbol).toBe('ETH');
    expect(r.recipient).toBe('vitalik.eth');
  });

  it('send alias works the same as transfer', () => {
    const r = parseIntent('send 1 USDC to vitalik.eth');
    expect(r.kind).toBe('transfer');
  });

  it('transfer with bad recipient → unknown', () => {
    const r = parseIntent('transfer 1 USDC to notanaddress');
    expect(r.kind).toBe('unknown');
  });
});

describe('parseIntent — kh', () => {
  it('kh discover (no search) → kh-discover with no search', () => {
    const r = parseIntent('kh discover');
    expect(r.kind).toBe('kh-discover');
    if (r.kind !== 'kh-discover') throw new Error('discriminant');
    expect(r.search).toBeUndefined();
  });

  it('kh discover compliance → kh-discover with search', () => {
    const r = parseIntent('kh discover compliance');
    expect(r.kind).toBe('kh-discover');
    if (r.kind !== 'kh-discover') throw new Error('discriminant');
    expect(r.search).toBe('compliance');
  });

  it('kh inspect some-slug → kh-inspect', () => {
    const r = parseIntent('kh inspect some-slug');
    expect(r.kind).toBe('kh-inspect');
    if (r.kind !== 'kh-inspect') throw new Error('discriminant');
    expect(r.workflowId).toBe('some-slug');
  });

  it('kh hire some-slug (no inputs) → kh-hire', () => {
    const r = parseIntent('kh hire some-slug');
    expect(r.kind).toBe('kh-hire');
    if (r.kind !== 'kh-hire') throw new Error('discriminant');
    expect(r.slugOrId).toBe('some-slug');
    expect(r.inputs).toBeUndefined();
  });

  it('kh hire some-slug {"key":"val"} → kh-hire with parsed inputs', () => {
    const r = parseIntent('kh hire some-slug {"key":"val"}');
    expect(r.kind).toBe('kh-hire');
    if (r.kind !== 'kh-hire') throw new Error('discriminant');
    expect(r.slugOrId).toBe('some-slug');
    expect(r.inputs).toEqual({ key: 'val' });
  });

  it('kh hire with invalid JSON inputs → unknown', () => {
    const r = parseIntent('kh hire some-slug {bad json}');
    expect(r.kind).toBe('unknown');
  });

  it('kh (no sub-verb) → unknown', () => {
    const r = parseIntent('kh');
    expect(r.kind).toBe('unknown');
  });
});

describe('parseIntent — mint', () => {
  it('mint audit → { kind: "mint", role: "audit" }', () => {
    const r = parseIntent('mint audit');
    expect(r.kind).toBe('mint');
    if (r.kind !== 'mint') throw new Error('discriminant');
    expect(r.role).toBe('audit');
  });

  it('mint oracle → { kind: "mint", role: "oracle" }', () => {
    const r = parseIntent('mint oracle');
    expect(r.kind).toBe('mint');
    if (r.kind !== 'mint') throw new Error('discriminant');
    expect(r.role).toBe('oracle');
  });

  it('mint swap → { kind: "mint", role: "swap" }', () => {
    const r = parseIntent('mint swap');
    expect(r.kind).toBe('mint');
    if (r.kind !== 'mint') throw new Error('discriminant');
    expect(r.role).toBe('swap');
  });

  it('mint (no role) → unknown', () => {
    expect(parseIntent('mint').kind).toBe('unknown');
  });

  it('mint unknown-role → unknown', () => {
    expect(parseIntent('mint guardian').kind).toBe('unknown');
  });
});

describe('parseIntent — single-word operator intents', () => {
  it('balances → { kind: "balances" }', () => {
    expect(parseIntent('balances').kind).toBe('balances');
  });

  it('agents → { kind: "agents" }', () => {
    expect(parseIntent('agents').kind).toBe('agents');
  });

  it('block → { kind: "block" }', () => {
    expect(parseIntent('block').kind).toBe('block');
  });

  it('cancel → { kind: "cancel" }', () => {
    expect(parseIntent('cancel').kind).toBe('cancel');
  });

  it('balances with trailing args → unknown (strict single-word)', () => {
    expect(parseIntent('balances all').kind).toBe('unknown');
  });
});

describe('parseIntent — park / unpark', () => {
  it('park 1 USDC → park with amount=1, symbol=USDC, tokenId=1n (default)', () => {
    const r = parseIntent('park 1 USDC');
    expect(r.kind).toBe('park');
    if (r.kind !== 'park') throw new Error('discriminant');
    expect(r.amount).toBe('1');
    expect(r.symbol).toBe('USDC');
    expect(r.tokenId).toBe(1n);
  });

  it('unpark 0.5 WETH → unpark with amount=0.5, symbol=WETH', () => {
    const r = parseIntent('unpark 0.5 WETH');
    expect(r.kind).toBe('unpark');
    if (r.kind !== 'unpark') throw new Error('discriminant');
    expect(r.amount).toBe('0.5');
    expect(r.symbol).toBe('WETH');
    expect(r.tokenId).toBe(1n);
  });

  it('park 2 1 USDC → explicit tokenId=2n', () => {
    const r = parseIntent('park 2 1 USDC');
    expect(r.kind).toBe('park');
    if (r.kind !== 'park') throw new Error('discriminant');
    expect(r.tokenId).toBe(2n);
    expect(r.amount).toBe('1');
  });

  it('park ETH → unknown (ETH not a ParkSymbol)', () => {
    expect(parseIntent('park 1 ETH').kind).toBe('unknown');
  });

  it('park (missing args) → unknown', () => {
    expect(parseIntent('park').kind).toBe('unknown');
  });
});

// ── 2. Format helpers ─────────────────────────────────────────────────────────

describe('pad', () => {
  it('pads shorter string with trailing spaces', () => {
    expect(pad('hi', 5)).toBe('hi   ');
  });

  it('truncates string that is longer than n', () => {
    expect(pad('toolong', 3)).toBe('too');
  });

  it('returns string unchanged when length exactly equals n', () => {
    expect(pad('abc', 3)).toBe('abc');
  });

  it('handles empty string', () => {
    expect(pad('', 4)).toBe('    ');
  });
});

describe('shortHash', () => {
  it('shortens a long hash to first-6 + ellipsis + last-4', () => {
    const h = '0x1234567890abcdef1234';
    const result = shortHash(h);
    expect(result).toBe('0x1234…1234');
  });

  it('returns short string unchanged (≤ 12 chars)', () => {
    expect(shortHash('0x12345678').length).toBeLessThanOrEqual(12);
    expect(shortHash('0x12345678')).toBe('0x12345678');
  });

  it('includes the last 4 characters of the original hash', () => {
    const h = '0xabcdef0123456789';
    const result = shortHash(h);
    expect(result.endsWith('6789')).toBe(true);
  });
});

describe('formatStaged', () => {
  it('formats audit intent with topic', () => {
    const result = formatStaged({
      kind: 'audit',
      target: 'oracle.zhgg.eth',
      tokenId: 2n,
      topic: 'eu-ai-act',
    });
    expect(result).toContain('audit');
    expect(result).toContain('oracle.zhgg.eth');
    expect(result).toContain('eu-ai-act');
    expect(result).toContain('#2');
  });

  it('formats swap intent', () => {
    const result = formatStaged({
      kind: 'swap',
      amount: '10',
      fromSym: 'USDC',
      toSym: 'WETH',
    });
    expect(result).toContain('swap');
    expect(result).toContain('10');
    expect(result).toContain('USDC');
    expect(result).toContain('WETH');
  });

  it('formats transfer intent', () => {
    const result = formatStaged({
      kind: 'transfer',
      amount: '5',
      symbol: 'USDC',
      recipient: '0x1234567890123456789012345678901234567890',
    });
    expect(result).toContain('transfer');
    expect(result).toContain('5');
    expect(result).toContain('USDC');
  });

  it('formats kh-hire intent with inputs indicator', () => {
    const result = formatStaged({
      kind: 'kh-hire',
      slugOrId: 'mcp-test',
      inputs: { address: '0x123' },
    });
    expect(result).toContain('kh hire');
    expect(result).toContain('mcp-test');
    expect(result).toContain('+inputs');
  });

  it('formats kh-hire intent without inputs', () => {
    const result = formatStaged({ kind: 'kh-hire', slugOrId: 'mcp-test' });
    expect(result).toContain('kh hire');
    expect(result).not.toContain('+inputs');
  });

  it('returns "—" for non-formattable intents (empty/unknown)', () => {
    expect(formatStaged({ kind: 'empty' })).toBe('—');
  });
});

// ── 3. Agent status ───────────────────────────────────────────────────────────

describe('liveAgents', () => {
  it('returns exactly 3 agent rows', () => {
    const rows = liveAgents();
    expect(rows.length).toBe(3);
  });

  it('includes tokenIds 1n, 2n, 3n', () => {
    const rows = liveAgents();
    const tokenIds = rows.map((r) => r.tokenId).sort((a, b) => (a < b ? -1 : 1));
    expect(tokenIds).toEqual([1n, 2n, 3n]);
  });

  it('each row has a non-empty name and scope', () => {
    for (const row of liveAgents()) {
      expect(row.name.length).toBeGreaterThan(0);
      expect(row.scope.length).toBeGreaterThan(0);
    }
  });
});

describe('agentStatus — during audit command', () => {
  const agents = liveAgents();
  const auditAgent = agents.find((r) => r.tokenId === 1n)!;
  const oracleAgent = agents.find((r) => r.tokenId === 2n)!;
  const swapAgent = agents.find((r) => r.tokenId === 3n)!;

  const auditIntent = parseIntent('audit 1');

  it('tokenId matching staged audit intent → SUBJECT label', () => {
    const s = agentStatus(auditAgent, auditIntent, 'audit');
    expect(s.label).toContain('SUBJECT');
  });

  it('oracle agent (tokenId 2n) → CONSULTED label', () => {
    const s = agentStatus(oracleAgent, auditIntent, 'audit');
    expect(s.label).toContain('CONSULTED');
  });

  it('swap agent → idle during audit', () => {
    const s = agentStatus(swapAgent, auditIntent, 'audit');
    expect(s.label.toLowerCase()).toContain('idle');
  });
});

describe('agentStatus — during ask-oracle command', () => {
  const agents = liveAgents();
  const oracleAgent = agents.find((r) => r.tokenId === 2n)!;
  const auditAgent = agents.find((r) => r.tokenId === 1n)!;

  it('oracle agent → QUERIED label', () => {
    const s = agentStatus(oracleAgent, null, 'ask-oracle');
    expect(s.label).toContain('QUERIED');
  });

  it('non-oracle agent → idle', () => {
    const s = agentStatus(auditAgent, null, 'ask-oracle');
    expect(s.label.toLowerCase()).toContain('idle');
  });
});

describe('agentStatus — during swap command', () => {
  const agents = liveAgents();
  const swapAgent = agents.find((r) => r.tokenId === 3n)!;
  const auditAgent = agents.find((r) => r.tokenId === 1n)!;

  it('swap agent → EXECUTING label', () => {
    const s = agentStatus(swapAgent, null, 'swap');
    expect(s.label).toContain('EXECUTING');
  });

  it('non-swap agent → idle during swap', () => {
    const s = agentStatus(auditAgent, null, 'swap');
    expect(s.label.toLowerCase()).toContain('idle');
  });
});

describe('agentStatus — staged intent (not yet dispatched)', () => {
  const agents = liveAgents();
  const auditAgent = agents.find((r) => r.tokenId === 1n)!;

  it('matching audit tokenId → STAGED label when idle', () => {
    const auditIntent = parseIntent('audit 1');
    const s = agentStatus(auditAgent, auditIntent, 'idle');
    expect(s.label).toContain('STAGED');
  });

  it('no staged intent → idle', () => {
    const s = agentStatus(auditAgent, null, 'idle');
    expect(s.label.toLowerCase()).toContain('idle');
  });
});

// ── 4. Orchestrator step ──────────────────────────────────────────────────────

describe('applyOrchestratorStep — oracle.payment.request', () => {
  beforeEach(clearAudit);

  it('resets nodes to [active,off,off,off] and rails to off', () => {
    const env = mkEnv();
    // pre-dirty the state to confirm reset works
    env.flow.nodes = ['done', 'done', 'done', 'done'];
    env.flow.rails = { x402: 'done', direct_split: 'done' };
    env.flow.complete = true;

    applyOrchestratorStep(env, { tMs: 0, name: 'oracle.payment.request' });

    expect(env.flow.nodes).toEqual(['active', 'off', 'off', 'off']);
    expect(env.flow.rails.x402).toBe('off');
    expect(env.flow.rails.direct_split).toBe('off');
    expect(env.flow.complete).toBe(false);
    expect(env.flow.settledRail).toBeNull();
  });
});

describe('applyOrchestratorStep — oracle.spend_cap.check', () => {
  beforeEach(clearAudit);

  it('advances nodes to [done,active,off,off]', () => {
    const env = mkEnv();
    applyOrchestratorStep(env, { tMs: 10, name: 'oracle.spend_cap.check' });
    expect(env.flow.nodes).toEqual(['done', 'active', 'off', 'off']);
    expect(env.flow.complete).toBe(false);
  });
});

describe('applyOrchestratorStep — oracle.spend_cap.exceeded', () => {
  beforeEach(clearAudit);

  it('sets all nodes to rejected/done and marks complete=true', () => {
    const env = mkEnv();
    applyOrchestratorStep(env, {
      tMs: 15,
      name: 'oracle.spend_cap.exceeded',
      detail: { reason: 'cap_exceeded' },
    });
    expect(env.flow.nodes[1]).toBe('rejected');
    expect(env.flow.nodes[2]).toBe('rejected');
    expect(env.flow.nodes[3]).toBe('rejected');
    expect(env.flow.complete).toBe(true);
  });

  it('cap_not_found reason still sets complete=true', () => {
    const env = mkEnv();
    applyOrchestratorStep(env, {
      tMs: 15,
      name: 'oracle.spend_cap.exceeded',
      detail: { reason: 'cap_not_found' },
    });
    expect(env.flow.complete).toBe(true);
  });
});

describe('applyOrchestratorStep — oracle.payment.settle', () => {
  beforeEach(clearAudit);

  it('x402 rail → rails.x402=done, settledRail=x402', () => {
    const env = mkEnv();
    applyOrchestratorStep(env, {
      tMs: 200,
      name: 'oracle.payment.settle',
      detail: { rail: 'x402', txHash: '0xdeadbeef' },
    });
    expect(env.flow.rails.x402).toBe('done');
    expect(env.flow.rails.direct_split).toBe('rejected');
    expect(env.flow.settledRail).toBe('x402');
    expect(env.flow.nodes).toEqual(['done', 'done', 'active', 'off']);
  });

  it('direct_split rail → rails.direct_split=done, settledRail=direct_split', () => {
    const env = mkEnv();
    applyOrchestratorStep(env, {
      tMs: 200,
      name: 'oracle.payment.settle',
      detail: { rail: 'direct_split', txHash: '0xdeadbeef' },
    });
    expect(env.flow.rails.direct_split).toBe('done');
    expect(env.flow.rails.x402).toBe('rejected');
    expect(env.flow.settledRail).toBe('direct_split');
  });

  it('unknown rail → both rails rejected, settledRail=null', () => {
    const env = mkEnv();
    applyOrchestratorStep(env, {
      tMs: 200,
      name: 'oracle.payment.settle',
      detail: { rail: 'mystery', txHash: '0xdeadbeef' },
    });
    expect(env.flow.rails.x402).toBe('rejected');
    expect(env.flow.rails.direct_split).toBe('rejected');
    expect(env.flow.settledRail).toBeNull();
  });
});

describe('applyOrchestratorStep — audit.start', () => {
  beforeEach(clearAudit);

  it('advances nodes to [done,done,done,active]', () => {
    const env = mkEnv();
    applyOrchestratorStep(env, { tMs: 1000, name: 'audit.start', detail: { agentId: '1' } });
    expect(env.flow.nodes).toEqual(['done', 'done', 'done', 'active']);
    expect(env.flow.complete).toBe(false);
  });
});

describe('applyOrchestratorStep — audit.complete', () => {
  beforeEach(clearAudit);

  it('sets all nodes to done and complete=true', () => {
    const env = mkEnv();
    applyOrchestratorStep(env, {
      tMs: 5000,
      name: 'audit.complete',
      detail: { verdict: 'compliant', findingsCount: 2 },
    });
    expect(env.flow.nodes).toEqual(['done', 'done', 'done', 'done']);
    expect(env.flow.complete).toBe(true);
  });
});

describe('applyOrchestratorStep — audit.failed', () => {
  beforeEach(clearAudit);

  it('sets EXECUTE node to rejected and complete=true', () => {
    const env = mkEnv();
    applyOrchestratorStep(env, {
      tMs: 4000,
      name: 'audit.failed',
      detail: { reason: 'TEE timeout' },
    });
    expect(env.flow.nodes[3]).toBe('rejected');
    expect(env.flow.complete).toBe(true);
  });
});

describe('applyOrchestratorStep — audit.receipt.post', () => {
  beforeEach(clearAudit);

  it('sets all nodes to done and complete=true', () => {
    const env = mkEnv();
    applyOrchestratorStep(env, {
      tMs: 5500,
      name: 'audit.receipt.post',
      detail: { txHash: '0xabcdef' },
    });
    expect(env.flow.nodes).toEqual(['done', 'done', 'done', 'done']);
    expect(env.flow.complete).toBe(true);
  });
});

describe('applyOrchestratorStep — audit.receipt.failed', () => {
  beforeEach(clearAudit);

  it('node[3] not done → sets to rejected and complete=true', () => {
    const env = mkEnv();
    env.flow.nodes = ['done', 'done', 'done', 'active'];
    applyOrchestratorStep(env, {
      tMs: 5500,
      name: 'audit.receipt.failed',
      detail: { reason: 'chain write error' },
    });
    expect(env.flow.nodes[3]).toBe('rejected');
    expect(env.flow.complete).toBe(true);
  });

  it('node[3] already done → stays done (no downgrade)', () => {
    const env = mkEnv();
    env.flow.nodes = ['done', 'done', 'done', 'done'];
    applyOrchestratorStep(env, {
      tMs: 5600,
      name: 'audit.receipt.failed',
      detail: { reason: 'late failure' },
    });
    expect(env.flow.nodes[3]).toBe('done');
  });
});

// ── 5. Flow state ─────────────────────────────────────────────────────────────

describe('mkFlow', () => {
  it('creates fresh state with all nodes off', () => {
    const f = mkFlow();
    expect(f.nodes).toEqual(['off', 'off', 'off', 'off']);
  });

  it('creates fresh state with all rails off', () => {
    const f = mkFlow();
    expect(f.rails.x402).toBe('off');
    expect(f.rails.direct_split).toBe('off');
  });

  it('creates fresh state with complete=false', () => {
    expect(mkFlow().complete).toBe(false);
  });

  it('creates fresh state with settledRail=null', () => {
    expect(mkFlow().settledRail).toBeNull();
  });

  it('each call returns an independent object (no shared reference)', () => {
    const a = mkFlow();
    const b = mkFlow();
    a.nodes[0] = 'active';
    expect(b.nodes[0]).toBe('off');
  });
});
