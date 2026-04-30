/// `setAgentTextRecords` — write ENS text records on a `*.zhgg.eth` subname so
/// external indexers can resolve `<label>.zhgg.eth` → ERC-7857 iNFT,
/// ERC-8004 passport (CAIP-2 reference), and the agent tier.
///
/// Two txs:
///   1. (precondition) ENSRegistry.setResolver — `ENSRegistrar.publicMintSubname`
///      currently uses `setSubnodeOwner`, which leaves the child node's
///      resolver at address(0). Without a resolver, `setText` reverts.
///      Skipped automatically when the resolver is already set.
///   2. PublicResolver.multicall(setText × N) — fans out 4 setText calls
///      via the resolver's self-delegatecall multicall, collapsing them
///      into one transaction confirmation on the demo screen.
///
/// Custom keys (`agent.*`) follow ENSIP-5's dotted-namespace convention so
/// they don't collide with future canonical ENSIP keys.

import {
  encodeFunctionData,
  namehash,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { normalize } from 'viem/ens';

/// PublicResolver addresses — set as the subname's resolver before writing
/// text records. Sourced from /docs/ens.md.
export const PUBLIC_RESOLVER_MAINNET: Address =
  '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63';
export const PUBLIC_RESOLVER_SEPOLIA: Address =
  '0x8FADE66B79cC9f707aB26799354482EB93a5B7dD';

/// ENS Registry — same canonical address on mainnet + Sepolia.
export const ENS_REGISTRY: Address = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';

const ENS_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'resolver',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'setResolver',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'resolver', type: 'address' },
    ],
    outputs: [],
  },
] as const;

const PUBLIC_RESOLVER_ABI = [
  {
    type: 'function',
    name: 'setText',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'key', type: 'string' },
      { name: 'value', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'multicall',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'data', type: 'bytes[]' }],
    outputs: [{ name: 'results', type: 'bytes[]' }],
  },
] as const;

/// Canonical text-record keys zhgg writes for every agent.
export const TEXT_KEYS = {
  inft: 'agent.inft',
  passport: 'agent.passport',
  tier: 'agent.tier',
  endpoint: 'agent.endpoint',
} as const;

export interface SetAgentTextRecordsOpts {
  /// Subname under zhgg.eth — e.g. `"audit"` for `audit.zhgg.eth`.
  label: string;
  /// `0xAgentNFTAddress:tokenId`, e.g. `"0xabc...:7"`.
  inft: string;
  /// CAIP-2 ERC-8004 reference, e.g. `"eip155:16602:0xRegistry:agentId"`.
  passport: string;
  /// Agent tier.
  tier: 'oracle' | 'audit';
  /// Optional MCP endpoint URL.
  endpoint?: string;
  /// PublicResolver address — pass `PUBLIC_RESOLVER_SEPOLIA` or
  /// `PUBLIC_RESOLVER_MAINNET`, or override for a custom resolver.
  resolver: Address;
  /// Parent name. Defaults to `"zhgg.eth"`.
  parent?: string;
}

/// Structural client pair — typed `any` to dodge viem's deeply generic
/// `WalletClient<Transport, Chain, Account>` shape that requires callers
/// to thread chain/account/transport type parameters through. The helper
/// only exercises four standard viem methods (readContract,
/// simulateContract, writeContract, waitForTransactionReceipt) — runtime
/// correctness is preserved by the abi + args validation viem performs
/// internally.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ClientPair {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wallet: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient: any;
}

export async function setAgentTextRecords(
  client: ClientPair,
  opts: SetAgentTextRecordsOpts
): Promise<{ txHashes: Hex[] }> {
  const parent = opts.parent ?? 'zhgg.eth';
  const fqdn = normalize(`${opts.label}.${parent}`);
  const node = namehash(fqdn);

  const records: Array<[string, string]> = [
    [TEXT_KEYS.inft, opts.inft],
    [TEXT_KEYS.passport, opts.passport],
    [TEXT_KEYS.tier, opts.tier],
  ];
  if (opts.endpoint) records.push([TEXT_KEYS.endpoint, opts.endpoint]);

  const account = client.wallet.account;
  if (!account) throw new Error('wallet client has no account bound');
  const chain = client.wallet.chain ?? null;
  // simulateContract / writeContract internally check the abi+args shape;
  // structural typing on the public clients preserves runtime correctness
  // even though the wrapper types don't pin viem's strict generics.

  const txHashes: Hex[] = [];

  // Step 1 — ensure resolver is set. The registrar's `publicMintSubname`
  // uses `setSubnodeOwner`, which leaves resolver=0. Without a resolver,
  // PublicResolver.setText reverts on a resolver-mismatch path.
  const currentResolver: Address = await client.publicClient.readContract({
    address: ENS_REGISTRY,
    abi: ENS_REGISTRY_ABI,
    functionName: 'resolver',
    args: [node],
  });

  if (currentResolver === zeroAddress || currentResolver.toLowerCase() !== opts.resolver.toLowerCase()) {
    const { request: setResolverReq } = await client.publicClient.simulateContract({
      account,
      address: ENS_REGISTRY,
      abi: ENS_REGISTRY_ABI,
      functionName: 'setResolver',
      args: [node, opts.resolver],
    });
    const txHash = await client.wallet.writeContract({ ...setResolverReq, chain });
    await client.publicClient.waitForTransactionReceipt({ hash: txHash });
    txHashes.push(txHash);
  }

  // Step 2 — multicall fan-out of N setText calls into a single tx.
  const calldata = records.map(([key, value]) =>
    encodeFunctionData({
      abi: PUBLIC_RESOLVER_ABI,
      functionName: 'setText',
      args: [node, key, value],
    })
  );
  const { request } = await client.publicClient.simulateContract({
    account,
    address: opts.resolver,
    abi: PUBLIC_RESOLVER_ABI,
    functionName: 'multicall',
    args: [calldata],
  });
  const multicallTx = await client.wallet.writeContract({ ...request, chain });
  await client.publicClient.waitForTransactionReceipt({ hash: multicallTx });
  txHashes.push(multicallTx);

  return { txHashes };
}
