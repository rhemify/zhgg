/// ACP / EIP-8183 escrow intents (Slice J) — real on-chain dispatchers.
///
/// Two operations against the deployed AgenticCommerce contract on 0G
/// Galileo (chainId 16602):
///
///   acp create <agentTokenId> <usdcAmount>
///     - resolve agentTokenId → provider via AgentNFT.ownerOf(tokenId)
///     - createJob(provider, evaluator=0x0 → caller, paymentToken,
///                 expiredAt = now + 1 day, "zhgg-tui acp", hook=0x0)
///       → returns jobId via JobCreated event
///     - approve(paymentToken → AgenticCommerce, usdcAmount)
///     - fund(jobId, usdcAmount)
///
///   acp release <jobId>
///     - complete(jobId, reason=keccak("zhgg-tui release"))
///       → only callable by evaluator; same wallet that created the job
///         must release it (we set evaluator==client at create-time)
///
/// Required env (refused with a precise reason if missing):
///   ACP_ADDRESS         — AgenticCommerce on 0G Galileo
///   AGENT_NFT_ADDRESS   — ERC-7857 iNFT on 0G Galileo (provider lookup)
///   ACP_PAYMENT_TOKEN   — ERC-20 payment token address on 0G Galileo
///   ZG_RPC_URL          — 0G Galileo RPC endpoint
///   MINT_AGENT_PRIVATE_KEY (or ZG_PRIVATE_KEY) — deployer key on 0G
///
/// Reverts bubble verbatim — the contract's NotEvaluator / WrongState /
/// InvalidJobId errors are surfaced as the audit row's event text. We
/// never silently swallow a revert and never fabricate a tx hash.

import {
  decodeEventLog,
  keccak256,
  parseAbi,
  parseUnits,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';

// ─── ABIs ───────────────────────────────────────────────────────────────
//
// Minimal-surface ABIs verified against contracts/src/AgenticCommerce.sol
// (deployed at 0x6b90618b48d199e1d0df75179d26c2b97e80af44 on chain 16602).
// We expose only the four functions / one event we actually call.

const AGENTIC_COMMERCE_ABI = parseAbi([
  // createJob(provider, evaluator, paymentToken, expiredAt, description, hook) → jobId
  'function createJob(address provider, address evaluator, address paymentToken, uint64 expiredAt, string description, address hook) returns (uint256 jobId)',
  // fund(jobId, expectedBudget) — pulls ERC-20 from msg.sender (must approve first)
  'function fund(uint256 jobId, uint256 expectedBudget)',
  // complete(jobId, reason) — evaluator only; releases escrow → provider, fee → treasury
  'function complete(uint256 jobId, bytes32 reason)',
  // event JobCreated — first arg is the jobId we recover for fund()
  'event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint64 expiredAt, string description, address hook)',
]);

const AGENT_NFT_OWNER_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
]);

const ERC20_APPROVE_ABI = parseAbi([
  'function approve(address spender, uint256 value) returns (bool)',
  'function decimals() view returns (uint8)',
]);

// ─── Shared types ───────────────────────────────────────────────────────
//
// AcpRow shape mirrors operator-intents.ts' OpRow. Kept local (not
// imported) so this module has no cross-file dependency beyond viem —
// the index.ts caller adapts via a thin onProgress hook.

export interface AcpRow {
  agent: string;
  event: string;
  ok: 'ok' | 'err' | 'info';
}

export interface AcpCreateInput {
  /// Resolved iNFT token id (already validated by the parser).
  tokenId: bigint;
  /// Operator-typed target label, kept verbatim for the audit row.
  target: string;
  /// Decimal-string amount; converted to atomic via parseUnits(_, 6).
  usdcAmount: string;
  /// AgenticCommerce contract address on 0G Galileo.
  acpAddress: Address;
  /// AgentNFT (ERC-7857) address on 0G Galileo for ownerOf lookup.
  agentNftAddress: Address;
  /// ERC-20 payment token address on 0G Galileo. Decimals are assumed 6
  /// (matches USDC); the dispatcher does NOT call decimals() because the
  /// mission specifies parseUnits(_, 6) verbatim.
  paymentToken: Address;
  zgPublicClient: PublicClient;
  zgWalletClient: WalletClient;
  callerAddress: Address;
  /// Streaming hook so the TUI can paint per-stage progress without
  /// waiting for the full create-fund round trip (3 txs back-to-back
  /// can take 20–40s on a loaded testnet RPC).
  onProgress?: (row: AcpRow) => void;
}

export type AcpCreateResult =
  | { ok: true; jobId: bigint; createTx: Hex; approveTx: Hex; fundTx: Hex; budgetAtomic: bigint }
  | { ok: false; reason: string };

/// Create + fund an ACP job in three sequential txs. The contract
/// requires this split because createJob is non-payable (no value
/// transfer) and fund() pulls via safeTransferFrom — the standard
/// ERC-20 escrow pattern. We don't try to batch via multicall here
/// because AgenticCommerce isn't multicall-enabled and approvals must
/// land before the fund pull regardless.
export async function dispatchAcpCreate(input: AcpCreateInput): Promise<AcpCreateResult> {
  const emit = (row: AcpRow): void => {
    input.onProgress?.(row);
  };

  // 1. Resolve provider — AgentNFT.ownerOf(tokenId) on 0G.
  emit({
    agent: 'acp',
    event: `acp.create.intent target=${input.target} (#${input.tokenId}) amount=${input.usdcAmount}`,
    ok: 'info',
  });
  let provider: Address;
  try {
    provider = (await input.zgPublicClient.readContract({
      address: input.agentNftAddress,
      abi: AGENT_NFT_OWNER_ABI,
      functionName: 'ownerOf',
      args: [input.tokenId],
    })) as Address;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    emit({ agent: 'acp', event: `acp.create.failed ownerOf(#${input.tokenId}): ${reason}`.slice(0, 160), ok: 'err' });
    return { ok: false, reason };
  }
  emit({
    agent: 'acp',
    event: `acp.create.provider tokenId=#${input.tokenId} owner=${shortAddr(provider)}`,
    ok: 'info',
  });

  // 2. Convert decimal amount to atomic. Probe the token's actual
  //    decimals() at runtime so a non-USDC ERC-20 (8dp WBTC, 18dp DAI,
  //    etc.) doesn't silently produce an escrow budget that's off by
  //    orders of magnitude. The previous version hardcoded 6dp on the
  //    USDC-only assumption — flagged by review as a footgun for any
  //    operator who ever points ACP_PAYMENT_TOKEN at a different asset.
  let tokenDecimals: number;
  try {
    tokenDecimals = (await input.zgPublicClient.readContract({
      address: input.paymentToken,
      abi: ERC20_APPROVE_ABI,
      functionName: 'decimals',
    })) as number;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    emit({
      agent: 'acp',
      event: `acp.create.failed decimals() probe on ${shortAddr(input.paymentToken)}: ${reason}`.slice(0, 160),
      ok: 'err',
    });
    return { ok: false, reason };
  }
  let budgetAtomic: bigint;
  try {
    budgetAtomic = parseUnits(input.usdcAmount, tokenDecimals);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    emit({ agent: 'acp', event: `acp.create.parse: ${reason}`.slice(0, 160), ok: 'err' });
    return { ok: false, reason };
  }
  emit({
    agent: 'acp',
    event: `acp.create.budget ${input.usdcAmount} → ${budgetAtomic} atomic (${tokenDecimals}dp)`,
    ok: 'info',
  });

  // 3. createJob — evaluator passed as 0x0 so the contract rewrites it
  //    to msg.sender (per Solidity source line 147). This makes the
  //    caller both client AND evaluator, which is what `acp release`
  //    relies on (only the evaluator can call complete()).
  const expiredAt = BigInt(Math.floor(Date.now() / 1000)) + 86_400n; // now + 1 day
  emit({
    agent: 'acp',
    event: `acp.create.tx submitting createJob → ${shortAddr(input.acpAddress)} on 0G Galileo`,
    ok: 'info',
  });
  let createTx: Hex;
  let jobId: bigint;
  try {
    const sim = await input.zgPublicClient.simulateContract({
      account: input.callerAddress,
      address: input.acpAddress,
      abi: AGENTIC_COMMERCE_ABI,
      functionName: 'createJob',
      args: [
        provider,
        '0x0000000000000000000000000000000000000000', // evaluator → caller
        input.paymentToken,
        expiredAt,
        'zhgg-tui acp',
        '0x0000000000000000000000000000000000000000', // no hook
      ],
    });
    createTx = await input.zgWalletClient.writeContract(sim.request);
    const rcpt = await input.zgPublicClient.waitForTransactionReceipt({ hash: createTx });
    if (rcpt.status !== 'success') {
      const reason = `createJob tx reverted (status=${rcpt.status})`;
      emit({ agent: 'acp', event: `acp.create.failed ${reason}`, ok: 'err' });
      return { ok: false, reason };
    }
    // Recover jobId from the JobCreated event — the ONLY ground truth.
    // We deliberately do NOT fall back to sim.result: simulation runs
    // against pre-tx state, so a concurrent createJob landing between
    // simulate and write would record the wrong jobId here, and the
    // subsequent fund() call would target a stranger's job. Refuse loud
    // if the log is missing rather than guessing — flagged by review.
    let parsedJobId: bigint | null = null;
    for (const log of rcpt.logs) {
      if (log.address.toLowerCase() !== input.acpAddress.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: AGENTIC_COMMERCE_ABI,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === 'JobCreated') {
          parsedJobId = decoded.args.jobId;
          break;
        }
      } catch {
        // not a JobCreated topic — skip silently
      }
    }
    if (parsedJobId === null) {
      const reason = `createJob tx mined but no JobCreated log emitted by ${shortAddr(input.acpAddress)} — refusing rather than trusting sim.result (race-prone)`;
      emit({ agent: 'acp', event: `acp.create.failed ${reason}`.slice(0, 220), ok: 'err' });
      return { ok: false, reason };
    }
    jobId = parsedJobId;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    emit({ agent: 'acp', event: `acp.create.reverted createJob: ${reason}`.slice(0, 160), ok: 'err' });
    return { ok: false, reason };
  }
  emit({
    agent: 'acp',
    event: `acp.create.confirmed jobId=${jobId} tx=${shortHash(createTx)}`,
    ok: 'ok',
  });

  // 4. approve — ACP pulls ERC-20 via safeTransferFrom inside fund().
  //    We approve EXACTLY the budget (not max) because this is a
  //    single-shot escrow, not a recurring spender. Re-running an
  //    `acp create` for the same operator stacks a fresh approval each
  //    time, which is the safer default than leaving infinite allowance
  //    on a testnet-deployed contract.
  emit({
    agent: 'acp',
    event: `acp.approve.tx submitting approve(${shortAddr(input.acpAddress)}, ${input.usdcAmount}) → ${shortAddr(input.paymentToken)}`,
    ok: 'info',
  });
  let approveTx: Hex;
  try {
    const sim = await input.zgPublicClient.simulateContract({
      account: input.callerAddress,
      address: input.paymentToken,
      abi: ERC20_APPROVE_ABI,
      functionName: 'approve',
      args: [input.acpAddress, budgetAtomic],
    });
    approveTx = await input.zgWalletClient.writeContract(sim.request);
    const rcpt = await input.zgPublicClient.waitForTransactionReceipt({ hash: approveTx });
    if (rcpt.status !== 'success') {
      const reason = `approve tx reverted (status=${rcpt.status})`;
      emit({ agent: 'acp', event: `acp.approve.failed ${reason}`, ok: 'err' });
      return { ok: false, reason };
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    emit({ agent: 'acp', event: `acp.approve.reverted: ${reason}`.slice(0, 160), ok: 'err' });
    return { ok: false, reason };
  }
  emit({
    agent: 'acp',
    event: `acp.approve.confirmed tx=${shortHash(approveTx)}`,
    ok: 'ok',
  });

  // 5. fund — pulls budgetAtomic into escrow.
  emit({
    agent: 'acp',
    event: `acp.fund.tx submitting fund(${jobId}, ${input.usdcAmount}) → ${shortAddr(input.acpAddress)}`,
    ok: 'info',
  });
  let fundTx: Hex;
  try {
    const sim = await input.zgPublicClient.simulateContract({
      account: input.callerAddress,
      address: input.acpAddress,
      abi: AGENTIC_COMMERCE_ABI,
      functionName: 'fund',
      args: [jobId, budgetAtomic],
    });
    fundTx = await input.zgWalletClient.writeContract(sim.request);
    const rcpt = await input.zgPublicClient.waitForTransactionReceipt({ hash: fundTx });
    if (rcpt.status !== 'success') {
      const reason = `fund tx reverted (status=${rcpt.status})`;
      emit({ agent: 'acp', event: `acp.fund.failed ${reason}`, ok: 'err' });
      return { ok: false, reason };
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    emit({ agent: 'acp', event: `acp.fund.reverted: ${reason}`.slice(0, 160), ok: 'err' });
    return { ok: false, reason };
  }
  emit({
    agent: 'acp',
    event: `acp.created jobId=${jobId} escrowed=${input.usdcAmount} USDC tx=${shortHash(fundTx)}`,
    ok: 'ok',
  });

  return { ok: true, jobId, createTx, approveTx, fundTx, budgetAtomic };
}

export interface AcpReleaseInput {
  jobId: bigint;
  acpAddress: Address;
  zgPublicClient: PublicClient;
  zgWalletClient: WalletClient;
  callerAddress: Address;
  onProgress?: (row: AcpRow) => void;
}

export type AcpReleaseResult =
  | { ok: true; jobId: bigint; txHash: Hex }
  | { ok: false; reason: string };

/// Release a submitted job — calls AgenticCommerce.complete(jobId, reason).
/// Only the evaluator may call. We surface the chain's revert reason
/// verbatim so common mistakes (NotEvaluator, WrongState, InvalidJobId)
/// reach the operator unfiltered.
///
/// Note: the contract requires the job to be in `Submitted` state before
/// `complete()` will release escrow. A funded-but-not-submitted job
/// reverts with WrongState(jobId, Submitted, Funded). The TUI surfaces
/// this exactly — the operator decides whether to wait for the provider
/// to submit() or to refund via reject().
export async function dispatchAcpRelease(input: AcpReleaseInput): Promise<AcpReleaseResult> {
  const emit = (row: AcpRow): void => {
    input.onProgress?.(row);
  };
  emit({
    agent: 'acp',
    event: `acp.release.intent jobId=${input.jobId}`,
    ok: 'info',
  });
  // Reason is a bytes32 marker — we hash a fixed string so off-chain
  // indexers can identify TUI-originated releases without parsing the
  // tx submitter. Not security-critical; just a provenance breadcrumb.
  const reason = keccak256(toHex('zhgg-tui release'));
  emit({
    agent: 'acp',
    event: `acp.release.tx submitting complete(${input.jobId}, ${shortHash(reason)}) → ${shortAddr(input.acpAddress)}`,
    ok: 'info',
  });
  let txHash: Hex;
  try {
    const sim = await input.zgPublicClient.simulateContract({
      account: input.callerAddress,
      address: input.acpAddress,
      abi: AGENTIC_COMMERCE_ABI,
      functionName: 'complete',
      args: [input.jobId, reason],
    });
    txHash = await input.zgWalletClient.writeContract(sim.request);
    const rcpt = await input.zgPublicClient.waitForTransactionReceipt({ hash: txHash });
    if (rcpt.status !== 'success') {
      const r = `complete tx reverted (status=${rcpt.status})`;
      emit({ agent: 'acp', event: `acp.release.failed ${r}`, ok: 'err' });
      return { ok: false, reason: r };
    }
  } catch (e) {
    const r = e instanceof Error ? e.message : String(e);
    emit({ agent: 'acp', event: `acp.release.reverted: ${r}`.slice(0, 160), ok: 'err' });
    return { ok: false, reason: r };
  }
  emit({
    agent: 'acp',
    event: `acp.released jobId=${input.jobId} tx=${shortHash(txHash)}`,
    ok: 'ok',
  });
  return { ok: true, jobId: input.jobId, txHash };
}

// ─── helpers ────────────────────────────────────────────────────────────

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function shortHash(h: string): string {
  return h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h;
}
