import { describe, it, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { applyStep, runFromEvents, type RunnerState } from '../src/events-runner.js';

function freshState(): RunnerState {
  return { agents: new Map(), splits: [], startedAt: 0 };
}

describe('applyStep — orchestrator step → TUI state', () => {
  it('payment.request brings audit + oracle online', () => {
    const s = freshState();
    applyStep(s, { tMs: 0, name: 'oracle.payment.request' });
    expect(s.agents.get('audit')?.status).toBe('running');
    expect(s.agents.get('oracle')?.status).toBe('running');
  });

  it('payment.settle pushes a split row and updates oracle action', () => {
    const s = freshState();
    applyStep(s, {
      tMs: 600,
      name: 'oracle.payment.settle',
      detail: { txHash: '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' },
    });
    expect(s.splits.length).toBe(1);
    expect(s.splits[0]!.context).toBe('audit → oracle');
    expect(s.agents.get('oracle')?.lastAction).toMatch(/payment settled/);
  });

  it('audit.complete with compliant verdict marks audit done', () => {
    const s = freshState();
    applyStep(s, {
      tMs: 5000,
      name: 'audit.complete',
      detail: { verdict: 'compliant', findingsCount: 3 },
    });
    expect(s.agents.get('audit')?.status).toBe('done');
    expect(s.agents.get('audit')?.lastAction).toContain('compliant');
  });

  it('audit.complete with non-compliant verdict marks audit error', () => {
    const s = freshState();
    applyStep(s, {
      tMs: 5000,
      name: 'audit.complete',
      detail: { verdict: 'unclear' },
    });
    expect(s.agents.get('audit')?.status).toBe('error');
  });

  it('spend_cap.exceeded marks audit error with reason', () => {
    const s = freshState();
    applyStep(s, {
      tMs: 100,
      name: 'oracle.spend_cap.exceeded',
      detail: { reason: 'cap_exceeded' },
    });
    const audit = s.agents.get('audit');
    expect(audit?.status).toBe('error');
    expect(audit?.lastAction).toContain('cap_exceeded');
  });

  it('axiom + memory_root events update audit lastAction without changing status', () => {
    const s = freshState();
    applyStep(s, { tMs: 0, name: 'audit.start', detail: { agentId: '1' } });
    applyStep(s, { tMs: 100, name: 'audit.axiom.commit' });
    expect(s.agents.get('audit')?.lastAction).toContain('AXIOM');
    expect(s.agents.get('audit')?.status).toBe('running');

    applyStep(s, { tMs: 200, name: 'audit.memory_root.pin' });
    expect(s.agents.get('audit')?.lastAction).toContain('memoryRoot');

    applyStep(s, { tMs: 300, name: 'audit.axiom.reveal' });
    expect(s.agents.get('audit')?.lastAction).toContain('revealed');
  });

  it('unknown step name is silently ignored', () => {
    const s = freshState();
    applyStep(s, { tMs: 0, name: 'oracle.gibberish.xyz' });
    expect(s.agents.size).toBe(0);
    expect(s.splits.length).toBe(0);
  });
});

describe('runFromEvents — full subscription lifecycle', () => {
  it('forwards each declared step name through applyStep', () => {
    const s = freshState();
    const ee = new EventEmitter();
    const stepNames = ['oracle.payment.request', 'oracle.payment.settle'] as const;

    const teardown = runFromEvents(s, ee, stepNames);

    ee.emit('oracle.payment.request', { tMs: 0, name: 'oracle.payment.request' });
    ee.emit('oracle.payment.settle', { tMs: 600, name: 'oracle.payment.settle' });

    expect(s.agents.get('audit')?.status).toBe('running');
    expect(s.splits.length).toBe(1);

    teardown();
    // After teardown, further events do not mutate state.
    ee.emit('oracle.payment.settle', { tMs: 999, name: 'oracle.payment.settle' });
    expect(s.splits.length).toBe(1);
  });

  it('does not subscribe to step names that are not declared', () => {
    const s = freshState();
    const ee = new EventEmitter();
    runFromEvents(s, ee, ['audit.complete']);

    // Emit an event the runner did not subscribe to → no-op.
    ee.emit('oracle.payment.request', { tMs: 0, name: 'oracle.payment.request' });
    expect(s.agents.size).toBe(0);
  });
});
