/// Multi-leg PaymentIntent.
///
/// One EIP-712 signature, many on-chain transfer legs across many chains.
/// Tailored to zhgg's agent-pay-agent pattern: each leg targets a
/// `FeeSplitter` or `AgentReceiverWallet` so the same signature can
/// fan out across Base, 0G, and any other EVM chain in a single user
/// action.
///
/// The relayer:
///  - verifies the EIP-712 signature against the declared `from`
///  - dedups by `(from, nonce)` against an injected store
///  - submits one tx per leg, one per chain (caller injects per-chain
///    wallet clients so the same orchestrator can drive Base + 0G)
///  - returns a `MultiLegResult` with per-leg tx hashes + which legs
///    failed
///
/// Replay defense is on the relayer side (the store) AND must be
/// enforced on-chain by `FeeSplitter` (see Phase 13b's `splitERC20Erc8021`
/// + ERC-8021 attribution suffix). The signature alone is not sufficient
/// to prevent on-chain replay — that's the asset-side contract's job.

import {
  hashTypedData,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';

export interface PaymentLeg {
  /// CAIP-2 chain id, e.g. "eip155:84532" (Base Sepolia) or "eip155:16602" (0G).
  chain: string;
  /// Settlement contract on `chain` — typically a FeeSplitter address.
  settler: Address;
  /// Recipient of the bulk leg (the agent owner the splitter routes to).
  recipient: Address;
  /// ERC-20 contract on `chain` (USDC default for zhgg).
  token: Address;
  /// Amount in atomic units of `token`.
  amount: bigint;
}

export interface PaymentIntent {
  /// Address that authorized this intent (signer).
  from: Address;
  /// Per-`from` monotonic nonce. Replay defense.
  nonce: bigint;
  /// Unix seconds. Relayer rejects after.
  deadline: bigint;
  /// One leg per chain × token × recipient triple.
  legs: readonly PaymentLeg[];
}

export const PAYMENT_INTENT_TYPES = {
  PaymentIntent: [
    { name: 'from', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'legs', type: 'PaymentLeg[]' },
  ],
  PaymentLeg: [
    { name: 'chain', type: 'string' },
    { name: 'settler', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
} as const;

export interface IntentDomain {
  /// Logical chain id of the relayer/orchestrator. The legs themselves
  /// can target any chain. The domain just scopes the signature so a
  /// malicious relayer on a different chain can't replay the bytes.
  chainId: number;
  /// The relayer service identifier (orchestrator contract or DNS).
  /// EIP-712 verifyingContract slot — even though our relayer is
  /// off-chain, declaring it pins the signature.
  verifyingContract: Address;
}

/// Replay-defense store. Production binds to a database; tests inject a
/// `Map`-backed store. The relayer asks `seen` before fanning out and
/// `record` after verification succeeds, all within a critical section.
export interface NonceStore {
  seen(from: Address, nonce: bigint): Promise<boolean>;
  record(from: Address, nonce: bigint): Promise<void>;
}

export interface InMemoryNonceStore extends NonceStore {
  /// Test introspection — production stores expose nothing equivalent.
  size(): number;
}

/// In-memory store for tests / local relayer dev. Backed by a `Set` of
/// `${from}:${nonce}` strings.
export function createInMemoryNonceStore(): InMemoryNonceStore {
  const used = new Set<string>();
  const key = (from: Address, nonce: bigint) =>
    `${from.toLowerCase()}:${nonce.toString()}`;
  return {
    async seen(from, nonce) {
      return used.has(key(from, nonce));
    },
    async record(from, nonce) {
      used.add(key(from, nonce));
    },
    size() {
      return used.size;
    },
  };
}

/// Compute the EIP-712 digest a signer covers when authorizing an intent.
/// Equivalent off-chain to what the on-chain `verifyingContract` would
/// hash if we ever moved verification on-chain.
export function paymentIntentDigest(domain: IntentDomain, intent: PaymentIntent): Hex {
  return hashTypedData({
    domain: {
      name: 'zhgg.PaymentIntent',
      version: '1',
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    types: PAYMENT_INTENT_TYPES,
    primaryType: 'PaymentIntent',
    message: {
      from: intent.from,
      nonce: intent.nonce,
      deadline: intent.deadline,
      legs: intent.legs.map((l) => ({
        chain: l.chain,
        settler: l.settler,
        recipient: l.recipient,
        token: l.token,
        amount: l.amount,
      })),
    },
  });
}

export type RelayError =
  | { kind: 'invalid_signature'; expected: Address; recovered: Address }
  | { kind: 'expired'; deadline: bigint; nowTs: bigint }
  | { kind: 'replay'; from: Address; nonce: bigint }
  | { kind: 'no_legs' }
  | { kind: 'unknown_chain'; chain: string }
  | { kind: 'leg_failed'; legIndex: number; chain: string; reason: string };

export interface RelayLegResult {
  legIndex: number;
  chain: string;
  txHash: Hex | null;
  error: string | null;
}

export interface RelayOutcome {
  ok: boolean;
  legs: RelayLegResult[];
  /// Top-level rejection reason — sig invalid, expired, replay,
  /// no legs, etc. Set when zero legs ran. When set, `legs` is empty.
  topLevelError: RelayError | null;
}

export interface ChainExecutor {
  /// Submit one leg to its chain. Returns the leg's tx hash on success.
  /// Implementations typically wrap a viem `walletClient.writeContract`
  /// call against the leg's `settler` (FeeSplitter.splitERC20).
  submit(args: {
    leg: PaymentLeg;
    legIndex: number;
    intentDigest: Hex;
  }): Promise<Hex>;
}

export interface RelayDeps {
  /// EIP-712 domain that scopes signatures.
  domain: IntentDomain;
  /// Per-chain executors, keyed by CAIP-2 chain id. Missing chain → leg
  /// rejected with `unknown_chain`.
  executors: Record<string, ChainExecutor>;
  /// Replay-defense store. Required.
  nonceStore: NonceStore;
  /// Override clock for tests.
  now?: () => bigint;
}

/// Relay a signed PaymentIntent: verify, fan out to per-chain executors,
/// return per-leg results. Atomic at the SIGNATURE level (one bad sig =
/// zero legs run); per-LEG failures are recorded but don't roll back
/// already-submitted legs (cross-chain rollback is impossible without
/// further infrastructure — Phase 20 Across handles that case).
export async function relayPaymentIntent(
  intent: PaymentIntent,
  signature: Hex,
  deps: RelayDeps
): Promise<RelayOutcome> {
  const now = deps.now ? deps.now() : BigInt(Math.floor(Date.now() / 1000));

  // 0. Empty legs is meaningless.
  if (intent.legs.length === 0) {
    return { ok: false, legs: [], topLevelError: { kind: 'no_legs' } };
  }

  // 1. Deadline.
  if (intent.deadline < now) {
    return {
      ok: false,
      legs: [],
      topLevelError: { kind: 'expired', deadline: intent.deadline, nowTs: now },
    };
  }

  // 2. Replay.
  if (await deps.nonceStore.seen(intent.from, intent.nonce)) {
    return {
      ok: false,
      legs: [],
      topLevelError: { kind: 'replay', from: intent.from, nonce: intent.nonce },
    };
  }

  // 3. Signature.
  const recovered = await recoverTypedDataAddress({
    domain: {
      name: 'zhgg.PaymentIntent',
      version: '1',
      chainId: deps.domain.chainId,
      verifyingContract: deps.domain.verifyingContract,
    },
    types: PAYMENT_INTENT_TYPES,
    primaryType: 'PaymentIntent',
    message: {
      from: intent.from,
      nonce: intent.nonce,
      deadline: intent.deadline,
      legs: intent.legs.map((l) => ({
        chain: l.chain,
        settler: l.settler,
        recipient: l.recipient,
        token: l.token,
        amount: l.amount,
      })),
    },
    signature,
  });
  if (recovered.toLowerCase() !== intent.from.toLowerCase()) {
    return {
      ok: false,
      legs: [],
      topLevelError: { kind: 'invalid_signature', expected: intent.from, recovered },
    };
  }

  // Record nonce BEFORE fanning out so a bug in an executor can't let
  // the same intent run twice.
  await deps.nonceStore.record(intent.from, intent.nonce);

  // 4. Fan out. Each leg is independent — one failing leg does NOT
  //    revert another leg's already-mined tx (cross-chain rollback is
  //    not in scope for this primitive).
  const digest = paymentIntentDigest(deps.domain, intent);
  const legs: RelayLegResult[] = [];
  for (let i = 0; i < intent.legs.length; ++i) {
    const leg = intent.legs[i]!;
    const executor = deps.executors[leg.chain];
    if (!executor) {
      legs.push({
        legIndex: i,
        chain: leg.chain,
        txHash: null,
        error: `unknown_chain ${leg.chain}`,
      });
      continue;
    }
    try {
      const txHash = await executor.submit({ leg, legIndex: i, intentDigest: digest });
      legs.push({ legIndex: i, chain: leg.chain, txHash, error: null });
    } catch (e) {
      legs.push({
        legIndex: i,
        chain: leg.chain,
        txHash: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const allOk = legs.every((l) => l.error === null);
  return { ok: allOk, legs, topLevelError: null };
}

/// Build a `ChainExecutor` from a viem `WalletClient` + a `FeeSplitter`
/// ABI. The executor calls `splitERC20(asset, totalAmount, agentOwner)`
/// on the leg's `settler` and approves first if needed. This is the
/// production path; tests inject simpler executors.
export function feeSplitterExecutor(deps: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  feeSplitterAbi: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  erc20Abi: any;
}): ChainExecutor {
  return {
    async submit({ leg }): Promise<Hex> {
      const { walletClient, publicClient, feeSplitterAbi, erc20Abi } = deps;
      const account = walletClient.account;
      if (!account) throw new Error('feeSplitterExecutor: walletClient has no account');

      // JIT approval — same pattern as live-deps.ts.
      const allowance = (await publicClient.readContract({
        address: leg.token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account.address, leg.settler],
      })) as bigint;
      if (allowance < leg.amount) {
        const approveSim = await publicClient.simulateContract({
          account,
          address: leg.token,
          abi: erc20Abi,
          functionName: 'approve',
          args: [leg.settler, leg.amount],
        });
        const approveTx = await walletClient.writeContract(approveSim.request);
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
      }

      const splitSim = await publicClient.simulateContract({
        account,
        address: leg.settler,
        abi: feeSplitterAbi,
        functionName: 'splitERC20',
        args: [leg.token, leg.amount, leg.recipient],
      });
      const txHash = await walletClient.writeContract(splitSim.request);
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      return txHash;
    },
  };
}
