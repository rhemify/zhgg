/// End-to-end test for the cinematic spotlight runtime — proves the
/// orchestrator + state + render wire up end-to-end and the final state
/// reflects the audit's outcome. Uses `__depsOverride` to inject mocked
/// CrossAgentDemoDeps so the test doesn't require a live testnet env;
/// production callers don't take this path (the runtime refuses without
/// real env, see spotlight-cli.ts).

import { describe, it, expect } from 'bun:test';
import { Writable } from 'node:stream';
import { runSpotlight, type SpotlightDepsBundle } from '../src/spotlight-cli.js';
import type { AuditDeps } from '@zhgg/audit-agent';
import type {
  Erc8004Client,
  PostError,
  Result,
  SettleOutput,
  ZGInferenceResult,
  ZGRouterError,
} from '@zhgg/workflow';

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

const FAKE_RECEIPT = '0xfeed000000000000000000000000000000000000000000000000000000000001' as `0x${string}`;
const FAKE_PAYMENT = '0xfeed000000000000000000000000000000000000000000000000000000000002' as `0x${string}`;

const FAKE_SETTLEMENT: SettleOutput = {
  txHash: FAKE_PAYMENT,
  network: 'eip155:84532',
  payer: '0xfeed000000000000000000000000000000000000',
  rail: 'direct_split',
};

function makeBundle(): SpotlightDepsBundle {
  let probeIndex = 0;
  const findings = [
    'agent does not engage in any practice prohibited under Article 5',
    'agent provides clear capability and limitation disclosure per Article 13',
    'agent discloses interaction is with an AI per Article 50',
  ];
  const infer: AuditDeps['infer'] = async (): Promise<
    Result<ZGInferenceResult, ZGRouterError>
  > => {
    const finding = findings[probeIndex] ?? 'compliant';
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
        receipt: `cmpl-fake-${probeIndex}`,
        provider_id: 'qwen3.6-plus-fake',
        tee_verified_locally: null,
        tee_verifier_reason: null,
      },
    };
  };
  const postReceipt = async (): Promise<Result<`0x${string}`, PostError>> => ({
    ok: true,
    value: FAKE_RECEIPT,
  });
  const erc8004Client: Erc8004Client = {
    giveFeedback: async () => FAKE_RECEIPT,
  };
  const auditDeps: AuditDeps = { infer, postReceipt, erc8004Client };
  return {
    deps: {
      settleOraclePayment: async () => FAKE_SETTLEMENT,
      auditDeps,
    },
    auditOptions: {
      apiKey: 'sk-test',
      registryAddress: '0x1111111111111111111111111111111111111111',
      agentRegistryCaip: 'eip155:16602:0x1111111111111111111111111111111111111111',
      clientAddress: 'eip155:84532:0x2222222222222222222222222222222222222222',
      quorum: 'majority',
    },
  };
}

describe('spotlight runtime — end-to-end', () => {
  it('runs through audit → complete and the captured output contains the verdict reveal', async () => {
    const cap = new CaptureStream();
    const result = await runSpotlight({
      target: 'oracle',
      out: cap as unknown as NodeJS.WriteStream,
      __depsOverride: makeBundle(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.finalState.phase).toBe('complete');
    expect(result.finalState.verdict).toBe('compliant');
    expect(result.finalState.probes.passed).toBe(3);

    const plain = stripAnsi(cap.buf);
    // Final verdict + section headers + evidence rows + receipts rows
    expect(plain).toContain('COMPLIANT');
    expect(plain).toContain('3/3 probes pass');
    expect(plain).toContain('Evidence');
    expect(plain).toContain('Receipts');
    expect(plain).toContain('Article 5');
    expect(plain).toContain('Article 13');
    expect(plain).toContain('Article 50');
    expect(plain).toContain('Cost');
    // Every line of the evidence + receipts blocks starts with the
    // strict 2-space prefix — no random indentation.
    const lines = plain.split('\n');
    const evidenceIdx = lines.findIndex((l) => l.trim() === 'Evidence');
    expect(evidenceIdx).toBeGreaterThan(0);
    // The two lines after Evidence should each start with exactly 2 spaces
    expect(lines[evidenceIdx + 1]?.startsWith('  ')).toBe(true);
    expect(lines[evidenceIdx + 1]?.startsWith('   ')).toBe(false);
  }, 30_000);

  it('refuses to start without live env (production path)', async () => {
    const cap = new CaptureStream();
    // Snapshot env, blank everything readLiveConfigFromEnv requires
    const saved = {
      ZG_ROUTER_KEY: process.env.ZG_ROUTER_KEY,
      BASE_SEPOLIA_PRIVATE_KEY: process.env.BASE_SEPOLIA_PRIVATE_KEY,
      ZG_PRIVATE_KEY: process.env.ZG_PRIVATE_KEY,
      BASE_SEPOLIA_RPC_URL: process.env.BASE_SEPOLIA_RPC_URL,
      ZG_RPC_URL: process.env.ZG_RPC_URL,
      FEE_SPLITTER_ADDRESS: process.env.FEE_SPLITTER_ADDRESS,
      AGENT_REGISTRY_ADDRESS: process.env.AGENT_REGISTRY_ADDRESS,
      ORACLE_OWNER_ADDRESS: process.env.ORACLE_OWNER_ADDRESS,
    };
    delete process.env.ZG_ROUTER_KEY;
    delete process.env.BASE_SEPOLIA_PRIVATE_KEY;
    delete process.env.ZG_PRIVATE_KEY;
    delete process.env.BASE_SEPOLIA_RPC_URL;
    delete process.env.ZG_RPC_URL;
    delete process.env.FEE_SPLITTER_ADDRESS;
    delete process.env.AGENT_REGISTRY_ADDRESS;
    delete process.env.ORACLE_OWNER_ADDRESS;
    try {
      const result = await runSpotlight({
        target: 'oracle',
        out: cap as unknown as NodeJS.WriteStream,
      });
      expect(result.exitCode).toBe(1);
      const plain = stripAnsi(cap.buf);
      expect(plain).toContain('refuses to run');
      expect(plain).toContain('ZG_ROUTER_KEY');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v !== undefined) process.env[k] = v;
      }
    }
  });
});
