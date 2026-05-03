/// Pure-function coverage for the audit-core aggregation helpers and
/// renderer. No I/O, no mocks. Complements `audit.test.ts` by closing
/// gaps on `aggregateFindings`, `renderProbe`, and edge cases on
/// `parseProbeResponse` / `aggregateVerdict`.

import { describe, it, expect } from 'bun:test';
import {
  aggregateFindings,
  aggregateVerdict,
  parseProbeResponse,
  renderProbe,
  PROBE_PROMPTS,
  type ProbeResult,
  type ProbePrompt,
} from '../src/audit-core.js';

const probeOf = (id: string, articleRef: string, compliant: boolean | null, finding: string): ProbeResult => ({
  id,
  articleRef,
  compliant,
  finding,
  renderedPrompt: '',
  modelId: '',
});

describe('parseProbeResponse — additional edge cases', () => {
  it('returns null on empty string input', () => {
    expect(parseProbeResponse('')).toBeNull();
  });

  it('returns null when compliant field is missing entirely', () => {
    expect(parseProbeResponse('{"finding": "looks ok"}')).toBeNull();
  });

  it('returns null when finding field is missing entirely', () => {
    expect(parseProbeResponse('{"compliant": true}')).toBeNull();
  });

  it('returns null when compliant is numeric (1) not boolean', () => {
    expect(parseProbeResponse('{"compliant": 1, "finding": "x"}')).toBeNull();
  });

  it('parses with an empty finding string', () => {
    expect(parseProbeResponse('{"compliant": true, "finding": ""}')).toEqual({
      compliant: true,
      finding: '',
    });
  });

  it('strips ``` (no json hint) markdown fences', () => {
    const out = parseProbeResponse('```\n{"compliant": false, "finding": "nope"}\n```');
    expect(out).toEqual({ compliant: false, finding: 'nope' });
  });
});

describe('aggregateVerdict — additional quorum cases', () => {
  it('majority quorum with all three null returns unclear', () => {
    const r = [
      probeOf('a', 'A', null, ''),
      probeOf('b', 'B', null, ''),
      probeOf('c', 'C', null, ''),
    ];
    expect(aggregateVerdict(r, { quorum: 'majority' })).toBe('unclear');
  });

  it('all quorum with all-null results returns unclear, not compliant', () => {
    const r = [probeOf('a', 'A', null, ''), probeOf('b', 'B', null, '')];
    expect(aggregateVerdict(r, { quorum: 'all' })).toBe('unclear');
  });

  it('single compliant probe under all quorum returns compliant', () => {
    expect(aggregateVerdict([probeOf('a', 'A', true, 'ok')])).toBe('compliant');
  });

  it('majority quorum with even split (2/2 + 0 unclear) returns unclear — no strict majority', () => {
    const r = [
      probeOf('a', 'A', true, ''),
      probeOf('b', 'B', false, ''),
      probeOf('c', 'C', true, ''),
      probeOf('d', 'D', false, ''),
    ];
    expect(aggregateVerdict(r, { quorum: 'majority' })).toBe('unclear');
  });
});

describe('aggregateFindings', () => {
  it('concatenates non-null findings in input order with article ref prefix', () => {
    const r = [
      probeOf('a', 'EU AI Act Article 5', true, 'no prohibited practice'),
      probeOf('b', 'EU AI Act Article 13', false, 'missing deployer info'),
      probeOf('c', 'EU AI Act Article 50', true, 'discloses ai'),
    ];
    const out = aggregateFindings(r);
    expect(out).toEqual([
      '[EU AI Act Article 5] no prohibited practice',
      '[EU AI Act Article 13] missing deployer info',
      '[EU AI Act Article 50] discloses ai',
    ]);
  });

  it('preserves order even when null/unclear probes are interleaved', () => {
    const r = [
      probeOf('a', 'A', true, 'first'),
      probeOf('b', 'B', null, 'inference failed'),
      probeOf('c', 'C', false, 'third'),
    ];
    const out = aggregateFindings(r);
    expect(out[0]).toBe('[A] first');
    expect(out[1]).toBe('[B] inference failed');
    expect(out[2]).toBe('[C] third');
  });

  it('returns empty array on empty input', () => {
    expect(aggregateFindings([])).toEqual([]);
  });
});

describe('renderProbe', () => {
  const probe: ProbePrompt = {
    id: 'test',
    articleRef: 'TEST',
    name: 'test probe',
    promptTemplate: 'Audit target: {{manifest}}\nReturn JSON.',
  };

  it('substitutes {{manifest}} placeholder with provided manifest', () => {
    expect(renderProbe(probe, 'oracle returns prices')).toBe(
      'Audit target: oracle returns prices\nReturn JSON.'
    );
  });

  it('does not crash on empty manifest — substitutes empty string', () => {
    expect(renderProbe(probe, '')).toBe('Audit target: \nReturn JSON.');
  });

  it('renders the live PROBE_PROMPTS without leftover placeholder', () => {
    for (const p of PROBE_PROMPTS) {
      const out = renderProbe(p, 'a sample manifest blob');
      expect(out).not.toContain('{{manifest}}');
      expect(out).toContain('a sample manifest blob');
    }
  });
});
