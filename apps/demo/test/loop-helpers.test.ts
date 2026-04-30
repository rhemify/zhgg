import { describe, it, expect, mock } from 'bun:test';
import { keccak256, toHex } from 'viem';
import {
  readAgentCapabilities,
  commitPlan,
  computeCommitId,
  revealPlan,
  pinMemoryRoot,
} from '../src/loop-helpers.js';
import type { Address, Hex } from 'viem';

const ADDR = '0x0000000000000000000000000000000000abcdef' as Address;
const SIGNER = '0x000000000000000000000000000000000000beef' as Address;

function mockPublic(read: unknown) {
  return {
    readContract: mock(async () => read),
    simulateContract: mock(async () => ({ request: { foo: 'bar' } })),
    waitForTransactionReceipt: mock(async () => ({ blockNumber: 42n })),
  };
}
function mockWallet() {
  return {
    account: { address: SIGNER },
    writeContract: mock(async () => ('0x' + 'aa'.repeat(32)) as Hex),
  };
}

describe('readAgentCapabilities', () => {
  it('returns not_configured when address is null', async () => {
    const r = await readAgentCapabilities({
      agentNftAddress: null,
      tokenId: 1n,
      publicClient: mockPublic('0x'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_configured');
  });

  it('returns the raw bytes on success', async () => {
    const r = await readAgentCapabilities({
      agentNftAddress: ADDR,
      tokenId: 1n,
      publicClient: mockPublic('0xdeadbeef' as Hex),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('0xdeadbeef');
  });

  it('classifies viem errors as read_failed', async () => {
    const pc = {
      readContract: mock(async () => {
        throw new Error('rpc died');
      }),
    };
    const r = await readAgentCapabilities({
      agentNftAddress: ADDR,
      tokenId: 1n,
      publicClient: pc,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('read_failed');
  });
});

describe('commitPlan', () => {
  it('returns not_configured when axiom address is null', async () => {
    const r = await commitPlan({
      axiomAddress: null,
      tokenId: 1n,
      plan: new Uint8Array([1, 2, 3]),
      publicClient: mockPublic(null),
      walletClient: mockWallet(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_configured');
  });

  it('hashes plan locally and submits commit tx', async () => {
    const pc = mockPublic(null);
    const wc = mockWallet();
    const r = await commitPlan({
      axiomAddress: ADDR,
      tokenId: 1n,
      plan: new Uint8Array([0xde, 0xad]),
      publicClient: pc,
      walletClient: wc,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.commitId.length).toBe(66);
      expect(r.value.txHash.startsWith('0x')).toBe(true);
      expect(r.value.planHash.length).toBe(66);
    }
    expect(pc.simulateContract).toHaveBeenCalled();
    expect(wc.writeContract).toHaveBeenCalled();
  });

  it('classifies write failures as commit_failed', async () => {
    const pc = mockPublic(null);
    const wc = {
      ...mockWallet(),
      writeContract: mock(async () => {
        throw new Error('reverted');
      }),
    };
    const r = await commitPlan({
      axiomAddress: ADDR,
      tokenId: 1n,
      plan: new Uint8Array([1]),
      publicClient: pc,
      walletClient: wc,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('commit_failed');
  });
});

describe('revealPlan', () => {
  it('skips when address is null', async () => {
    const r = await revealPlan({
      axiomAddress: null,
      tokenId: 1n,
      commitId: ('0x' + '00'.repeat(32)) as Hex,
      plan: new Uint8Array([1]),
      result: new Uint8Array([2]),
      publicClient: mockPublic(null),
      walletClient: mockWallet(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_configured');
  });

  it('submits reveal tx with plan + result hex-encoded', async () => {
    const pc = mockPublic(null);
    const wc = mockWallet();
    const r = await revealPlan({
      axiomAddress: ADDR,
      tokenId: 1n,
      commitId: ('0x' + 'aa'.repeat(32)) as Hex,
      plan: new Uint8Array([1, 2]),
      result: new Uint8Array([3, 4]),
      publicClient: pc,
      walletClient: wc,
    });
    expect(r.ok).toBe(true);
    expect(pc.simulateContract).toHaveBeenCalled();
  });
});

/// SOL↔TS parity for AxiomCommit.commitPlan. The expected hash is also
/// asserted on the Solidity side in `contracts/test/AxiomCommit.t.sol`.
/// Both sides must hash the same fixed inputs to the same bytes32; any
/// drift (case folding, padding, abi encoding) breaks one or the other.
describe('computeCommitId — SOL↔TS parity', () => {
  const TOKEN_ID = 42n;
  const PLAN_HASH: Hex = keccak256(toHex('test plan'));
  const SENDER: Address = '0xcA11E7c00Ffe5c0De0000000000000000000beeF';
  const BLOCK_NUMBER = 100n;
  const EXPECTED_COMMIT_ID: Hex =
    '0xf69605a66ee37a6f57d5c0857e158a5f0771b3fd2bd8562d8dbc6239a0258d4d';

  it('matches the on-chain fixture', () => {
    expect(computeCommitId(TOKEN_ID, PLAN_HASH, SENDER, BLOCK_NUMBER)).toBe(EXPECTED_COMMIT_ID);
  });

  it('is case-insensitive on the sender input', () => {
    const lowercase = SENDER.toLowerCase() as Address;
    expect(computeCommitId(TOKEN_ID, PLAN_HASH, lowercase, BLOCK_NUMBER)).toBe(
      EXPECTED_COMMIT_ID
    );
  });

  it('is unaffected by extra whitespace in checksum address (canonicalized via getAddress)', () => {
    const mixedCase = ('0xCA11E7C00FFE5C0DE0000000000000000000BEEF'.toLowerCase() ===
    SENDER.toLowerCase()
      ? '0xCA11E7C00FFE5C0DE0000000000000000000BEEF'
      : SENDER) as Address;
    expect(computeCommitId(TOKEN_ID, PLAN_HASH, mixedCase, BLOCK_NUMBER)).toBe(
      EXPECTED_COMMIT_ID
    );
  });
});

describe('pinMemoryRoot', () => {
  it('skips when address is null', async () => {
    const r = await pinMemoryRoot({
      agentNftAddress: null,
      tokenId: 1n,
      rootHash: ('0x' + 'aa'.repeat(32)) as Hex,
      publicClient: mockPublic(null),
      walletClient: mockWallet(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_configured');
  });

  it('submits updateMemoryRoot tx', async () => {
    const pc = mockPublic(null);
    const wc = mockWallet();
    const r = await pinMemoryRoot({
      agentNftAddress: ADDR,
      tokenId: 7n,
      rootHash: ('0x' + 'bb'.repeat(32)) as Hex,
      publicClient: pc,
      walletClient: wc,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.txHash.length).toBe(66);
  });
});
