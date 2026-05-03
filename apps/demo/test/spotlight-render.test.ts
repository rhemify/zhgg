/// Render snapshot tests for the cinematic spotlight CLI. Asserts on
/// the plain-text lines (no ANSI) so behavior is decoupled from the
/// terminal escape soup. Covers the four phase frames the demo walks
/// through: idle → running (mid-audit) → complete (proof reveal) →
/// failed (failure caption).

import { describe, it, expect } from 'bun:test';
import {
  initialState,
  reduce,
  targetConfidence,
  type SpotlightEvent,
} from '../src/spotlight/state.js';
import { renderLines, verdictLine, paintLines } from '../src/spotlight/render.js';

const PROBE_REFS = ['Article 50', 'Article 5', 'Article 13'];
const startEv = (): SpotlightEvent => ({
  type: 'audit.start',
  target: 'oracle.zhgg.eth',
  probesTotal: 3,
  probeRefs: PROBE_REFS,
});
const probeEv = (ref: string, pass: boolean, finding = 'compliant'): SpotlightEvent => ({
  type: 'probe.complete',
  ref,
  pass,
  finding,
  costUsd: 0.0006,
});

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

describe('verdictLine — phase progression', () => {
  it('idle phase produces empty verdict', () => {
    const s = initialState('oracle.zhgg.eth', 0);
    expect(verdictLine(s, 0)).toBe('');
  });

  it('running with no probes shows ◯ analyzing target', () => {
    let s = initialState('oracle.zhgg.eth', 0);
    s = reduce(s, startEv());
    expect(verdictLine(s, 30)).toBe('◯  analyzing oracle.zhgg.eth');
  });

  it('one probe pass shows ◐ leaning compliant with ratio + percent', () => {
    let s = initialState('oracle.zhgg.eth', 0);
    s = reduce(s, startEv());
    s = reduce(s, probeEv('Article 50', true));
    expect(verdictLine(s, 47)).toBe('◐  leaning compliant · 1/3 probes · 47%');
  });

  it('complete + compliant shows ● COMPLIANT 95%', () => {
    let s = initialState('oracle.zhgg.eth', 0);
    s = reduce(s, startEv());
    PROBE_REFS.forEach((r) => (s = reduce(s, probeEv(r, true))));
    s = reduce(s, { type: 'audit.complete', verdict: 'compliant', findings: [] });
    expect(verdictLine(s, 95)).toBe('●  COMPLIANT · 3/3 probes · 95%');
  });

  it('failed phase shows ✕ FAILED with no probe ratio', () => {
    let s = initialState('oracle.zhgg.eth', 0);
    s = reduce(s, startEv());
    s = reduce(s, { type: 'audit.failed', reason: 'spend cap exceeded' });
    expect(verdictLine(s, 0)).toBe('✕  FAILED');
  });
});

describe('renderLines — full frame composition', () => {
  it('idle frame has no verdict, no trail, no cost', () => {
    const s = initialState('oracle.zhgg.eth', 0);
    const { lines } = renderLines(s, 0);
    const visible = lines.filter((l) => l.trim().length > 0);
    expect(visible.length).toBe(0);
  });

  it('running frame includes verdict + 3 probe rows + cost line', () => {
    let s = initialState('oracle.zhgg.eth', 0);
    s = reduce(s, startEv());
    s = reduce(s, probeEv('Article 50', true, 'AI disclosure compliant'));
    const { lines } = renderLines(s, 47);
    const visible = lines.filter((l) => l.trim().length > 0).map((l) => l.trim());
    expect(visible).toContain('◐  leaning compliant · 1/3 probes · 47%');
    expect(visible.some((l) => l.startsWith('✓ Article 50'))).toBe(true);
    expect(visible.some((l) => l.startsWith('◯ Article 5 ') && l.includes('analyzing'))).toBe(
      true
    );
    expect(visible.some((l) => l.startsWith('$0.0006') && l.includes('1 probes'))).toBe(true);
  });

  it('complete frame includes proof artifact reveal block', () => {
    let s = initialState('oracle.zhgg.eth', 0);
    s = reduce(s, startEv());
    PROBE_REFS.forEach((r) => (s = reduce(s, probeEv(r, true))));
    s = reduce(s, { type: 'audit.complete', verdict: 'compliant', findings: [] });
    s = reduce(s, {
      type: 'audit.report.pin',
      uri: '0g://storage/0xabcdef0123',
      hash: '0x1234567890abcdef',
    });
    s = reduce(s, { type: 'oracle.payment.settle', txHash: '0xpayment000abc' });
    s = reduce(s, { type: 'audit.receipt.post', txHash: '0xreceipt000def' });
    const { lines } = renderLines(s, 95);
    const visible = lines.filter((l) => l.trim().length > 0).map((l) => l.trim());
    expect(visible).toContain('●  COMPLIANT · 3/3 probes · 95%');
    expect(visible.some((l) => l.startsWith('audit report'))).toBe(true);
    expect(visible.some((l) => l.startsWith('payment tx'))).toBe(true);
    expect(visible.some((l) => l.startsWith('receipt tx'))).toBe(true);
  });

  it('failed frame surfaces the reason caption', () => {
    let s = initialState('oracle.zhgg.eth', 0);
    s = reduce(s, startEv());
    s = reduce(s, { type: 'audit.failed', reason: 'router 502: backend down' });
    const { lines } = renderLines(s, 0);
    const visible = lines.filter((l) => l.trim().length > 0).map((l) => l.trim());
    expect(visible).toContain('✕  FAILED');
    expect(visible).toContain('router 502: backend down');
  });
});

describe('paintLines — ANSI safety', () => {
  it('stripped paint output equals plain renderLines output', () => {
    let s = initialState('oracle.zhgg.eth', 0);
    s = reduce(s, startEv());
    s = reduce(s, probeEv('Article 50', true));
    const plain = renderLines(s, 47).lines;
    const painted = paintLines(s, 47);
    expect(painted.map((l) => stripAnsi(l))).toEqual(plain);
  });
});
