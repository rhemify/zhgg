/// Integration test: a real `runCrossAgentDemo` run with mocked deps
/// MUST emit events that the TUI's `runFromEvents` projects into the
/// expected agent-row state. Proves the wire end-to-end — orchestrator
/// emits → TUI runner consumes → render state mutates correctly. No
/// mocked transcript replay; this drives a real orchestrator pass.

import { describe, it, expect, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { runCrossAgentDemo } from '../src/cross-agent.js';
import { applyStep, runFromEvents, type RunnerState } from '@zhgg/tui/events-runner';
import type { AuditDeps } from '@zhgg/audit-agent';
import type {
  Erc8004Client,
  PostError,
  Result,
  SettleOutput,
  ZGInferenceResult,
  ZGRouterError,
} from '@zhgg/workflow';

const ALL_STEP_NAMES = [
  'oracle.spend_cap.check',
  'oracle.spend_cap.exceeded',
  'oracle.payment.request',
  'oracle.payment.settle',
  'oracle.query.start',
  'oracle.query.complete',
  'audit.capabilities.read',
  'audit.axiom.commit',
  'audit.axiom.reveal',
  'audit.memory_root.pin',
  'audit.start',
  'audit.complete',
  'audit.failed',
  'audit.receipt.post',
  'audit.receipt.failed',
] as const;

function makeMockedAuditDeps(): AuditDeps {
  let probeIndex = 0;
  const probeFindings = [
    'agent discloses interaction per Article 50',
    'agent compliant with Article 5',
    'agent provides disclosure per Article 13',
  ];
  const infer = async (): Promise<Result<ZGInferenceResult, ZGRouterError>> => {
    const finding = probeFindings[probeIndex] ?? 'compliant';
    probeIndex += 1;
    return {
      ok: true,
      value: {
        response: JSON.stringify({ compliant: true, finding }),
        cost_usd: 0.0006,
        latency_ms: 240,
        attestation_root: null,
        tee_verified: null,
        tee_provider: null,
        receipt: `cmpl-mock-${probeIndex}`,
        provider_id: 'qwen3.6-plus-mock',
        tee_verified_locally: null,
        tee_verifier_reason: null,
      },
    };
  };
  const postReceipt = async (): Promise<Result<`0x${string}`, PostError>> => ({
    ok: true,
    value: '0x6d6f636b00000000000000000000000000000000000000000000000000000001',
  });
  const erc8004Client: Erc8004Client = {
    giveFeedback: async () =>
      '0x6d6f636b00000000000000000000000000000000000000000000000000000001' as `0x${string}`,
  };
  return {
    infer: infer as never,
    postReceipt: postReceipt as never,
    erc8004Client,
  };
}

const MOCK_SETTLEMENT: SettleOutput = {
  txHash: '0x6d6f636b00000000000000000000000000000000000000000000000000000002',
  network: 'eip155:84532',
  payer: '0x6d6f636b00000000000000000000000000000000',
  rail: 'direct_split',
};

describe('TUI ↔ orchestrator integration', () => {
  it('subscribes a RunnerState to live runCrossAgentDemo and reflects every step', async () => {
    const events = new EventEmitter();
    const state: RunnerState = { agents: new Map(), splits: [], startedAt: Date.now() };
    const teardown = runFromEvents(state, events, ALL_STEP_NAMES);

    const transcript = await runCrossAgentDemo(
      {
        settleOraclePayment: async () => MOCK_SETTLEMENT,
        auditDeps: makeMockedAuditDeps(),
      },
      {
        target: {
          agentId: 7n,
          agentName: 'audit',
          manifest: 'integration-test placeholder manifest',
        },
        oracleTopic: 'eu-ai-act',
        auditOptions: {
          apiKey: 'sk-mock',
          registryAddress: '0x1111111111111111111111111111111111111111',
          agentRegistryCaip: 'eip155:16602:0x1111111111111111111111111111111111111111',
          clientAddress: 'eip155:84532:0x2222222222222222222222222222222222222222',
          now: new Date().toISOString(),
          quorum: 'majority',
        },
        events,
      }
    );

    teardown();

    // Sanity: the orchestrator did fire the steps we expect.
    const stepNames = transcript.steps.map((s) => s.name);
    expect(stepNames).toContain('oracle.payment.request');
    expect(stepNames).toContain('oracle.payment.settle');
    expect(stepNames).toContain('audit.start');
    expect(stepNames).toContain('audit.complete');

    // The TUI state must reflect the agents the orchestrator touched.
    const audit = state.agents.get('audit');
    const oracle = state.agents.get('oracle');
    expect(audit).toBeDefined();
    expect(oracle).toBeDefined();

    // Successful run → audit ends in 'done'. The verdict event sets
    // status=done; receipt.post fires last and overwrites lastAction —
    // assert the final lastAction reflects that completion path.
    expect(audit!.status).toBe('done');
    expect(audit!.lastAction).toContain('receipt');

    // Settlement event pushed exactly one split row.
    expect(state.splits.length).toBe(1);
    expect(state.splits[0]!.context).toBe('audit → oracle');
  });

  it('teardown stops further state mutation', () => {
    const events = new EventEmitter();
    const state: RunnerState = { agents: new Map(), splits: [], startedAt: 0 };
    const teardown = runFromEvents(state, events, ['oracle.payment.request']);

    events.emit('oracle.payment.request', { tMs: 0, name: 'oracle.payment.request' });
    expect(state.agents.size).toBe(2);

    teardown();
    state.agents.clear();
    events.emit('oracle.payment.request', { tMs: 1000, name: 'oracle.payment.request' });
    expect(state.agents.size).toBe(0);
  });

  it('applyStep is the single source of truth for state projection', () => {
    // applyStep is exported separately so tests + non-event-emitter
    // drivers (e.g. transcript replay for snapshot testing) can use it
    // without spinning up a full EventEmitter.
    const state: RunnerState = { agents: new Map(), splits: [], startedAt: 0 };
    applyStep(state, { tMs: 0, name: 'oracle.payment.request' });
    expect(state.agents.size).toBe(2);
  });
});
