/// End-to-end test for the cinematic spotlight runtime — proves the
/// orchestrator + state + render wire up end-to-end and the final state
/// reflects the audit's outcome. We capture frames into a buffer
/// (instead of process.stdout) so the test can assert on what the
/// audience would see at the end of the run.

import { describe, it, expect } from 'bun:test';
import { Writable } from 'node:stream';
import { runSpotlight } from '../src/spotlight-cli.js';

class CaptureStream extends Writable {
  buf = '';
  override _write(
    chunk: Buffer | string,
    _enc: string,
    cb: (err?: Error | null) => void
  ): void {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    cb();
  }
}

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

describe('spotlight runtime — end-to-end', () => {
  it('runs through audit → complete and the captured output contains the verdict reveal', async () => {
    const cap = new CaptureStream();
    const result = await runSpotlight({
      target: 'oracle.zhgg.eth',
      fps: 60,
      out: cap as unknown as NodeJS.WriteStream,
    });

    expect(result.exitCode).toBe(0);
    expect(result.finalState.phase).toBe('complete');
    expect(result.finalState.verdict).toBe('compliant');
    expect(result.finalState.probes.passed).toBe(3);

    const plain = stripAnsi(cap.buf);
    // The final frame must contain the verdict reveal
    expect(plain).toContain('COMPLIANT');
    expect(plain).toContain('3/3 probes');
    // and the trail of probes
    expect(plain).toContain('Article 50');
    expect(plain).toContain('Article 5');
    expect(plain).toContain('Article 13');
  }, 30_000);
});
