import { describe, it, expect } from 'bun:test';
import { getCreate2Address, toHex, type Address, type Hex } from 'viem';
import { predictReceiverWalletAddress } from '../src/receiver-wallet.js';

/// SOL↔TS parity for CREATE2 derivation. Tests `getCreate2Address` (the
/// TS primitive predictReceiverWalletAddress wraps) against the same
/// fixture asserted in `contracts/test/AgentReceiverWallet.t.sol`. The
/// fixture is bytecode-independent — it locks the cross-language
/// CREATE2 address derivation, NOT the init-code-hash computation
/// (which both languages perform on the same bytes anyway).
describe('CREATE2 — SOL↔TS parity', () => {
  it('matches Solidity Create2.computeAddress for a fixed (factory, salt, hash) triple', () => {
    const factory = '0xfaC0101010101010101010101010101010101010' as Address;
    const salt = toHex(42n, { size: 32 });
    const initCodeHash =
      '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as Hex;
    const expected = '0x8946c09566121DC373d2C1640396296Ec11865Ef' as Address;

    const tsAddr = getCreate2Address({ from: factory, salt, bytecodeHash: initCodeHash });
    expect(tsAddr).toBe(expected);
  });

  /// Determinism check on the actual `predictReceiverWalletAddress`
  /// function — same inputs must produce the same address across runs,
  /// and different `tokenId`s must produce distinct addresses. Doesn't
  /// hardcode an expected address (the value depends on the receiver
  /// wallet's compiled bytecode, which changes when the contract
  /// evolves). The cross-language derivation is locked above.
  it('predictReceiverWalletAddress is deterministic and tokenId-distinct', () => {
    const FIXTURE = {
      factory: '0xfaC0101010101010101010101010101010101010' as Address,
      agentNft: '0xA9E1abaBaBabababAbababABaBAbabAbaBaBab01' as Address,
      feeSplitter: '0xFEe6EfEFefefefEfeFeFEFEFEFeFEfefEfefefE1' as Address,
      // 100 bytes of stand-in creation code — the function only needs
      // it as opaque input to keccak256, so any non-empty value works
      // for the determinism check.
      creationCode: ('0x' + 'aa'.repeat(100)) as Hex,
    };

    const a1 = predictReceiverWalletAddress({ ...FIXTURE, tokenId: 1n });
    const a1again = predictReceiverWalletAddress({ ...FIXTURE, tokenId: 1n });
    const a2 = predictReceiverWalletAddress({ ...FIXTURE, tokenId: 2n });

    expect(a1).toBe(a1again);
    expect(a1).not.toBe(a2);
    expect(a1.length).toBe(42);
  });
});
