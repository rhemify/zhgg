import { describe, it, expect } from 'bun:test';
import { createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import {
  DELEGATION_TYPES,
  MODE_SINGLE_CALL,
  delegationDigest,
  encodeExecution,
  encodePermissionContext,
  signDelegation,
  type Delegation,
} from '../src/delegation.js';

const VERIFYING_CONTRACT = '0xfaC0101010101010101010101010101010101010' as Address;
const DELEGATOR_WALLET = '0xA9E1abaBaBabababAbababABaBAbabAbaBaBab01' as Address;
const DELEGATE = '0xcA11E7c00Ffe5c0De0000000000000000000beeF' as Address;
const TARGET = '0xcafE000000000000000000000000000000000001' as Address;
const PRIV_KEY: Hex =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function fixtureDelegation(): Delegation {
  return {
    delegator: DELEGATOR_WALLET,
    delegate: DELEGATE,
    allowedTargets: [TARGET],
    maxValuePerCall: 0n,
    expiresAt: 1_800_000_000n,
    salt: ('0x' + 'aa'.repeat(32)) as Hex,
    spendCapAsset: '0x0000000000000000000000000000000000000000' as Address,
    permissionId: ('0x' + '00'.repeat(32)) as Hex,
    maxAmountPerRedeem: 0n,
  };
}

describe('DELEGATION_TYPES', () => {
  it('exposes a Delegation primary type with 9 fields', () => {
    expect(DELEGATION_TYPES.Delegation.length).toBe(9);
    expect(DELEGATION_TYPES.Delegation.map((f) => f.name)).toEqual([
      'delegator',
      'delegate',
      'allowedTargets',
      'maxValuePerCall',
      'expiresAt',
      'salt',
      'spendCapAsset',
      'permissionId',
      'maxAmountPerRedeem',
    ]);
  });
});

describe('delegationDigest', () => {
  it('produces a 32-byte 0x-prefixed hash', () => {
    const d = fixtureDelegation();
    const digest = delegationDigest(
      { chainId: 84532, verifyingContract: VERIFYING_CONTRACT },
      d
    );
    expect(digest.length).toBe(66);
    expect(digest.startsWith('0x')).toBe(true);
  });

  it('changes when any field changes (deterministic per-input)', () => {
    const d1 = fixtureDelegation();
    const d2: Delegation = { ...d1, salt: ('0x' + 'bb'.repeat(32)) as Hex };
    const domain = { chainId: 84532, verifyingContract: VERIFYING_CONTRACT };
    expect(delegationDigest(domain, d1)).not.toBe(delegationDigest(domain, d2));
  });

  it('changes when chainId changes (cross-chain replay defense)', () => {
    const d = fixtureDelegation();
    const a = delegationDigest({ chainId: 84532, verifyingContract: VERIFYING_CONTRACT }, d);
    const b = delegationDigest({ chainId: 16602, verifyingContract: VERIFYING_CONTRACT }, d);
    expect(a).not.toBe(b);
  });
});

describe('signDelegation', () => {
  it('produces a 65-byte (r||s||v) signature via viem signTypedData', async () => {
    const account = privateKeyToAccount(PRIV_KEY);
    const wallet = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http('http://localhost:0'),
    });
    const sig = await signDelegation(
      wallet,
      { chainId: 84532, verifyingContract: VERIFYING_CONTRACT },
      fixtureDelegation()
    );
    // 65 bytes = 132 hex chars + '0x'
    expect(sig.length).toBe(132);
    expect(sig.startsWith('0x')).toBe(true);
  });
});

describe('encodePermissionContext + encodeExecution', () => {
  it('encodes a permissionContext as ABI tuple of (Delegation, bytes)', () => {
    const d = fixtureDelegation();
    const sig = ('0x' + 'cc'.repeat(65)) as Hex;
    const ctx = encodePermissionContext(d, sig);
    expect(ctx.startsWith('0x')).toBe(true);
    // The encoded shape contains the signature bytes verbatim somewhere
    // — confirms the abi-encoder didn't drop or transform them.
    expect(ctx.toLowerCase()).toContain(sig.slice(2).toLowerCase());
  });

  it('encodes an Execution as a single-element ABI tuple', () => {
    const exec = encodeExecution({
      target: TARGET,
      value: 1_000_000n,
      data: '0xdeadbeef' as Hex,
    });
    expect(exec.startsWith('0x')).toBe(true);
    // Target address must appear in the encoded blob (left-padded).
    expect(exec.toLowerCase()).toContain(TARGET.slice(2).toLowerCase());
    // Calldata bytes must appear too.
    expect(exec.toLowerCase()).toContain('deadbeef');
  });
});

describe('MODE_SINGLE_CALL', () => {
  it('is bytes32(0) — the ERC-7579 single-call mode the manager accepts', () => {
    expect(MODE_SINGLE_CALL).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000000'
    );
  });
});
