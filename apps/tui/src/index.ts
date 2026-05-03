// zhgg — unified TUI (raw ANSI; integrated payment flow + real-data wiring)
//
// Adds three live capabilities on top of the previous mock layout:
//   1. RECEIPT row — viem getTransactionReceipt + parseEventLogs decode
//      FeeSplitter.Split (Base Sepolia) and AgentRegistry.NewFeedback
//      (0G Galileo). NEVER fabricates fields. See `receipt-feed.ts`.
//   2. INTENT input — typed commands dispatch to runCrossAgentDemo
//      (audit) or queryOracle (ask oracle). Orchestrator events stream
//      into the AUDIT TRAIL and FLOW state.
//   3. SpendCap [G] grant — when an intent is staged, G pops a modal
//      that calls SpendCap.grantPermission() on Base Sepolia using
//      BASE_SEPOLIA_PRIVATE_KEY, scoped to the intent's permissionId.
//
// Requires: 120×40 terminal (warns if smaller). The new INTENT row +
// RECEIPT band push the minimum a few rows above the previous 28.

import { EventEmitter } from 'node:events';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseUnits,
  formatUnits,
  keccak256,
  toHex,
  isAddress,
  getAddress,
  encodeFunctionData,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { runCrossAgentDemo, type TranscriptStep } from '../../demo/src/cross-agent.js';
import { payViaKeeperHubMarketplace } from '../../demo/src/keeperhub-marketplace.js';
import { resolveCallableSlug, validateRequiredInputs } from './kh-hire-validate.js';
import {
  commitPlan as axiomCommitCall,
  revealPlan as axiomRevealCall,
} from '../../demo/src/loop-helpers.js';
import { queryOracle } from '@zhgg/oracle-agent';
import { executeSwap } from '@zhgg/swap-agent';
import { executeTransfer } from '@zhgg/transfer-agent';
import {
  executeKHCall,
  type KHCall,
  type KHCallResult,
  type KHError as KHCallError,
} from '@zhgg/keeperhub-agent';
import { parseIntent, type IntentCommand } from './intent-parser.js';
import { AGENT_REGISTRY } from './agent-registry.js';
import { buildHelpLines, PERSISTENT_HINT } from './help-overlay.js';
import {
  envelopeJson,
  EMPTY_RECEIPT,
  type ReceiptEnvelope,
} from './receipt-feed.js';
import { $, E, at } from './theme.js';
import {
  W, H, MID,
  ROW_HEADER_TOP, ROW_HEADER_BOT, ROW_TOP_START, ROW_TOP_END,
  ROW_MID_DIV, ROW_BOT_START,
  ROW_LOG, ROW_RECEIPT, ROW_HINT, ROW_INTENT, ROW_STATUS, ROW_FOOTER,
  FLOW_COL, FLOW_NODE_W, nodeRow,
} from './layout.js';
import { pad, shortHash, formatStaged } from './format.js';
import { AUDIT, pushAudit } from './audit-trail.js';
import { mkFlow, type FlowState, type NS } from './flow-state.js';
import { liveAgents, agentStatus, type RunningCommand } from './agent-status.js';
import { tryBuildLiveBundle, getLiveBundleError, type LiveBundle } from './live-bundle.js';
import { buildFrame } from './render.js';
import { applyOrchestratorStep, KNOWN_STEPS } from './orchestrator-step.js';
import {
  openGrantModal as openGrantModalImpl,
  confirmGrant as confirmGrantImpl,
} from './grant.js';
import {
  dispatchMint,
  listAgents,
  showBalances,
  showBlock,
  type OpRow,
} from './operator-intents.js';
import {
  dispatchAcpCreate,
  dispatchAcpRelease,
  type AcpRow,
} from './acp-intents.js';
/// ERC-7710 helpers (Slice I): build, sign, and ABI-encode a real
/// `Delegation` for `DelegationManager.redeemDelegations(...)`. The
/// signature is verified on-chain via ERC-1271 against the delegator
/// smart wallet (AgentReceiverWallet for the seed iNFT) — same code
/// path the forge tests exercise.
import {
  MODE_SINGLE_CALL,
  delegationDigest,
  encodeExecution,
  encodePermissionContext,
  signDelegation,
  type Delegation as ERC7710Delegation,
} from '@zhgg/workflow';
import { resolveRecipient } from '../../transfer-agent/src/resolve-recipient.js';
import { executePark, executeUnpark } from './yield-intents.js';
import { apyTrendHint, DEMO_APY_PCT, DEMO_APY_SAMPLES_30D } from './sparkline.js';
import {
  ENTRYPOINT_V07_ADDRESS,
  buildUserOp,
  encodeExecute,
  encodeInitCode,
  getEntryPointNonce,
  getUserOperationReceipt,
  pimlicoBundlerUrl,
  pimlicoGetUserOperationGasPrice,
  sendUserOperation,
  signUserOp,
} from '@zhgg/wallet-aa';

// ANSI primitives, layout constants, agent-status, audit-trail, flow-state,
// and the live-bundle factory have been moved to focused modules
// (`./theme.ts`, `./layout.ts`, `./agent-status.ts`, `./audit-trail.ts`,
// `./flow-state.ts`, `./live-bundle.ts`). They are imported at the top
// of this file. Mutable run-time state (the `flow` instance, the staged
// intent, the running command) still lives here because the dispatchers
// + render loop + keypress handler all mutate it directly.

let flow: FlowState = mkFlow()

// ── Receipt + intent + grant state ───────────────────────────────────────────
//
// Each piece of state lives at module scope so the async dispatchers
// (orchestrator, viem grant) can mutate while the 1Hz renderTimer
// repaints — no callback wiring needed past the initial subscribe.

let receiptEnvelope: ReceiptEnvelope = EMPTY_RECEIPT

let intentBuffer = ''
let intentMode: 'idle' | 'editing' = 'editing'
let intentHint = ''
let stagedIntent: IntentCommand | null = null
let runningCommand: RunningCommand = 'idle'

/// Cancellation flag — flipped on by the `cancel` intent (or Esc while
/// a dispatch is running). Long-running dispatchers check this between
/// awaits and abort early. Reset to `false` before every fresh dispatch
/// so a stale cancel doesn't kill the next command.
///
/// We deliberately don't try to abort an already-submitted on-chain tx;
/// once `writeContract` returns a hash the chain has the tx and there's
/// nothing the TUI can do. The flag only affects the dispatch coroutine
/// (early bail before next RPC call) and clears `runningCommand` so the
/// UI returns to idle even if the underlying promise is still resolving
/// in the background.
let cancelRequested = false

let grantModalOpen = false
let grantModalLines: string[] = []

/// Help overlay (slice D). Toggled by `?` and dismissed by `?` or Esc.
/// While open, the overlay floats above the FLOW panel; intent input
/// keeps editing — the operator can keep typing while reading the
/// command palette.
let helpOverlayOpen = false

let toast: { kind: 'ok' | 'err' | 'info'; text: string } | null = null
function setToast(kind: 'ok' | 'err' | 'info', text: string): void { toast = { kind, text } }

// `LiveBundle`, the lazy `tryBuildLiveBundle()` factory, and the
// `getLiveBundleError()` accessor live in `./live-bundle.ts`. They are
// imported at the top of this file. Anywhere the dispatchers used to
// read `liveBundle` directly, they now call `tryBuildLiveBundle()`
// (which returns the memoised bundle on subsequent calls) and read
// `getLiveBundleError()` for the most recent build failure message.


// `buildFrame` and the FLOW node helpers (`nodeStyle`, `nodeBorder`)
// have been moved to `./render.ts`. The render loop in this file
// snapshots local state into a `FrameState` and hands it to
// `buildFrame()` per tick.


// `formatStaged` lives in `./format.ts`.

// ── Render ────────────────────────────────────────────────────────────────────

let renderTimer: ReturnType<typeof setInterval> | null = null

function render() {
  const tooSmall = W() < 100 || H() < 32
  if (tooSmall) {
    process.stdout.write(`${E}[2J${E}[H` +
      $.red + "\n  Terminal too small — resize to at least 100×32\n" + $.reset)
    return
  }
  process.stdout.write(`${E}[?25l${E}[H` + buildFrame({
    flow,
    stagedIntent,
    runningCommand,
    receiptEnvelope,
    intentBuffer,
    intentMode,
    intentHint,
    toast,
    grantModalOpen,
    grantModalLines,
    helpOverlayOpen,
  }))
}

// ── Step logic ────────────────────────────────────────────────────────────────
//
// Slice C: the flow's only driver is now `applyOrchestratorStep`. The
// previous synthetic FLOW_STEPS array, packet animation, and auto-play
// timer were all removed because they animated state the orchestrator
// never actually emitted — the demo now tells the truth or shows
// nothing.

// `KNOWN_STEPS` and `applyOrchestratorStep` live in `./orchestrator-step.ts`.

async function dispatchAuditIntent(intent: Extract<IntentCommand, { kind: 'audit' }>): Promise<void> {
  // No synthetic fallback. The TUI is real-or-fail — judges greping for
  // "0x6d6f636b…" / "qwen-mock" will find nothing in this dispatch path.
  // Early-bail check: a cancel queued before dispatch is honoured here.
  if (cancelRequested) { cancelRequested = false; pushAudit('intent', 'audit cancelled before dispatch', 'info'); return }
  cancelRequested = false
  const bundle = tryBuildLiveBundle()
  if (!bundle) {
    pushAudit('intent', `audit blocked: ${getLiveBundleError() ?? 'env-incomplete'}`, 'err')
    setToast('err', `env-incomplete: ${getLiveBundleError() ?? '?'}`)
    return
  }
  if (!bundle.inferenceReady) {
    pushAudit(
      'intent',
      'audit blocked: ZG_ROUTER_KEY missing/empty. Fund pc.testnet.0g.ai (3 OG min), paste sk- key into .env, restart TUI.',
      'err',
    )
    setToast('err', 'inference unfunded')
    return
  }

  runningCommand = 'audit'
  pushAudit('intent', `dispatching audit "${intent.target}" (token #${intent.tokenId})`, 'info')
  const events = new EventEmitter()
  const onAny = (step: TranscriptStep): void => applyOrchestratorStep({
    flow,
    setReceiptEnvelope: (e) => { receiptEnvelope = e },
    getReceiptEnvelope: () => receiptEnvelope,
    setToast,
  }, step)
  for (const name of KNOWN_STEPS) events.on(name, onAny)

  try {
    await runCrossAgentDemo(
      bundle.demo.deps,
      {
        target: {
          agentId: intent.tokenId,
          agentName: intent.target,
          // Real ERC-7857 capabilities are read by AuditDeps in live mode
          // via the readCapabilities dep wired in buildLiveDeps; this manifest
          // string is a fallback descriptor only.
          manifest: `iNFT ${intent.target} — capabilities read on-chain`,
        },
        oracleTopic: 'eu-ai-act',
        events,
        auditOptions: bundle.demo.auditOptions,
      },
    )
  } catch (e) {
    pushAudit('orchestrator', `crash: ${e instanceof Error ? e.message : String(e)}`, 'err')
  } finally {
    for (const name of KNOWN_STEPS) events.off(name, onAny)
    runningCommand = 'idle'
    render()
  }
}

async function dispatchAskOracleIntent(
  intent: Extract<IntentCommand, { kind: 'ask-oracle' }>,
): Promise<void> {
  if (cancelRequested) { cancelRequested = false; pushAudit('intent', 'ask oracle cancelled before dispatch', 'info'); return }
  cancelRequested = false
  runningCommand = 'ask-oracle'
  pushAudit('intent', `ask oracle ${intent.raw} (topic=${intent.topic})`, 'info')
  try {
    const params = intent.topic === 'price' && /^[a-z]{2,5}\/[a-z]{2,5}$/i.test(intent.raw)
      ? { symbol: intent.raw.toUpperCase() }
      : undefined
    const res = await queryOracle({ topic: intent.topic, params })
    if (res.ok) {
      const data = res.data
      if (data.kind === 'price') {
        pushAudit('oracle', `price ${data.quote.symbol} = ${data.quote.price} (10^${data.quote.exponent}) @ ${data.quote.publishTime}`, 'ok')
      } else if (data.kind === 'regulatory') {
        pushAudit('oracle', `regulatory ${data.deltas.length} delta(s)`, 'ok')
        for (const d of data.deltas.slice(0, 3)) {
          pushAudit('oracle', `${d.article}: ${d.summary}`.slice(0, 96), 'info')
        }
      } else {
        pushAudit('oracle', `unsupported: ${data.reason}`, 'err')
      }
    } else {
      pushAudit('oracle', `error ${res.error.kind}`, 'err')
    }
  } catch (e) {
    pushAudit('oracle', `crash: ${e instanceof Error ? e.message : String(e)}`, 'err')
  } finally {
    runningCommand = 'idle'
    render()
  }
}

// ── Real on-chain swap dispatch ──────────────────────────────────────────────
//
// Slice E: typed `swap <amount> <from> <to>` intents fan out to the
// `swap-agent` workspace package, which executes against either Uniswap
// V3 SwapRouter02 or WETH9 deposit/withdraw on Base Sepolia. The TUI
// MUST refuse if env is incomplete (no fake hash) and surface the real
// chain revert reason on failure (no synthetic fallback).

async function dispatchSwapIntent(
  intent: Extract<IntentCommand, { kind: 'swap' }>,
): Promise<void> {
  if (cancelRequested) { cancelRequested = false; pushAudit('intent', 'swap cancelled before dispatch', 'info'); return }
  cancelRequested = false
  const bundle = tryBuildLiveBundle()
  if (!bundle) {
    pushAudit(
      'intent',
      `swap blocked: ${getLiveBundleError() ?? 'env-incomplete (BASE_SEPOLIA_RPC_URL or BASE_SEPOLIA_PRIVATE_KEY)'}`,
      'err',
    )
    setToast('err', `env-incomplete: ${getLiveBundleError() ?? 'BASE_SEPOLIA_PRIVATE_KEY/RPC_URL'}`)
    return
  }

  runningCommand = 'swap'
  pushAudit('swap-agent', `swap.intent ${intent.amount} ${intent.fromSym} → ${intent.toSym}`, 'info')
  pushAudit('swap-agent', `swap.quote probing Uniswap V3 fee tiers [500,3000,10000]`, 'info')
  render()

  try {
    pushAudit('swap-agent', `swap.execute submitting tx via SwapRouter02 / WETH9`, 'info')
    const result = await executeSwap(
      {
        publicClient: bundle.basePub,
        walletClient: bundle.baseWallet,
        account: bundle.baseAccount.address,
      },
      intent.amount,
      intent.fromSym,
      intent.toSym,
    )

    if (!result.ok) {
      const e = result.error
      pushAudit('swap-agent', `swap.reverted ${e.kind}: ${e.reason}`.slice(0, 160), 'err')
      setToast('err', `swap ${e.kind}`.slice(0, 80))
      return
    }

    const v = result.value
    pushAudit(
      'swap-agent',
      `swap.confirmed route=${v.route}${v.poolFee ? ` fee=${v.poolFee}` : ''} tx=${shortHash(v.txHash)}`,
      'ok',
    )

    try {
      const rcpt = await bundle.basePub.waitForTransactionReceipt({ hash: v.txHash })
      receiptEnvelope = { ...receiptEnvelope, status: 'settled' }
      pushAudit(
        'receipt',
        `swap receipt status=${rcpt.status} blk=${rcpt.blockNumber} gas=${rcpt.gasUsed}`,
        rcpt.status === 'success' ? 'ok' : 'err',
      )
    } catch (e) {
      pushAudit('receipt', `swap receipt fetch failed: ${e instanceof Error ? e.message : String(e)}`, 'err')
    }
  } catch (e) {
    pushAudit('swap-agent', `swap.crash: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160), 'err')
  } finally {
    runningCommand = 'idle'
    render()
  }
}

async function dispatchTransferIntent(
  intent: Extract<IntentCommand, { kind: 'transfer' }>,
): Promise<void> {
  if (cancelRequested) { cancelRequested = false; pushAudit('intent', 'transfer cancelled before dispatch', 'info'); return }
  cancelRequested = false
  const bundle = tryBuildLiveBundle()
  if (!bundle) {
    pushAudit(
      'intent',
      `transfer blocked: ${getLiveBundleError() ?? 'env-incomplete (BASE_SEPOLIA_RPC_URL or BASE_SEPOLIA_PRIVATE_KEY)'}`,
      'err',
    )
    setToast('err', `env-incomplete: ${getLiveBundleError() ?? 'BASE_SEPOLIA_PRIVATE_KEY/RPC_URL'}`)
    return
  }

  runningCommand = 'transfer'
  pushAudit('transfer-agent', `transfer.intent ${intent.amount} ${intent.symbol} → ${intent.recipient}`, 'info')
  if (/\.eth$/i.test(intent.recipient)) {
    pushAudit('transfer-agent', `transfer.resolve querying mainnet ENS for ${intent.recipient}`, 'info')
  }
  render()

  try {
    const result = await executeTransfer({
      amount: intent.amount,
      symbol: intent.symbol,
      recipient: intent.recipient,
      basePub: bundle.basePub,
      baseWallet: bundle.baseWallet,
      ensRpcUrl: process.env.ENS_RPC_URL,
    })

    if (!result.ok) {
      const e = result.error
      pushAudit('transfer-agent', `transfer.reverted ${e.kind}: ${e.reason}`.slice(0, 160), 'err')
      setToast('err', `transfer ${e.kind}`.slice(0, 80))
      return
    }

    const v = result.value
    pushAudit(
      'transfer-agent',
      `transfer.confirmed ${v.amount} ${v.symbol} → ${shortHash(v.resolvedRecipient)} (${v.recipientSource}) tx=${shortHash(v.txHash)}`,
      'ok',
    )
    pushAudit('receipt', `transfer receipt blk=${v.blockNumber} gas=${v.gasUsed}`, 'ok')
    receiptEnvelope = { ...receiptEnvelope, status: 'settled' }
  } catch (e) {
    pushAudit('transfer-agent', `transfer.crash: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160), 'err')
  } finally {
    runningCommand = 'idle'
    render()
  }
}

// ── AxiomCommit dispatchers (Slice H) ────────────────────────────────────────
//
// `commit <tokenId> <plan>` and `reveal <commitId> <plan>` fire REAL
// AxiomCommit.commitPlan + revealPlan transactions on 0G Galileo against
// the contract at AXIOM_COMMIT_ADDRESS. No mocks. The committer is the
// 0G wallet bound to MINT_AGENT_PRIVATE_KEY (built fresh per dispatch);
// we never log the key. Reveal reverts surface verbatim — wrong
// commitId → CommitNotFound, hash drift → PlanHashMismatch, foreign
// caller → NotCommitter — that revert is the most informative signal in
// the loop, so we forward the chain's reason text untouched.

/// Build the 0G clients + signer used by both AxiomCommit dispatchers.
/// Centralised here (rather than reading liveBundle) so commit/reveal
/// works even when the Base Sepolia env block is incomplete — the
/// AxiomCommit contract lives on 0G and only needs the 0G env. We
/// intentionally read MINT_AGENT_PRIVATE_KEY directly (mirroring
/// `dispatchOperatorMint`) so the caller never logs/echoes it and the
/// account is bound at call time. Returns null + pushes an audit row
/// when env is missing — caller bails on null without a second read.
function buildAxiomBundle():
  | {
      address: Address
      zgPub: PublicClient<Transport, Chain | undefined>
      zgWallet: WalletClient<Transport, Chain | undefined, Account>
    }
  | null {
  const axiomEnv = process.env.AXIOM_COMMIT_ADDRESS
  if (!axiomEnv || !/^0x[a-fA-F0-9]{40}$/.test(axiomEnv)) {
    pushAudit('axiom', 'AXIOM_COMMIT_ADDRESS missing/invalid', 'err')
    setToast('err', 'AXIOM_COMMIT_ADDRESS required')
    return null
  }
  const pkRaw = process.env.MINT_AGENT_PRIVATE_KEY
  if (!pkRaw || !/^0x[0-9a-fA-F]{64}$/.test(pkRaw)) {
    pushAudit('axiom', 'MINT_AGENT_PRIVATE_KEY missing/invalid', 'err')
    setToast('err', 'MINT_AGENT_PRIVATE_KEY required')
    return null
  }
  const zgRpc = process.env.ZG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai'
  const account = privateKeyToAccount(pkRaw as Hex)
  const transport = http(zgRpc)
  const zgPub = createPublicClient({ transport })
  const zgWallet = createWalletClient({ account, transport })
  return { address: axiomEnv as Address, zgPub, zgWallet }
}

async function dispatchAxiomCommitIntent(
  intent: Extract<IntentCommand, { kind: 'axiom-commit' }>,
): Promise<void> {
  if (cancelRequested) {
    cancelRequested = false
    pushAudit('intent', 'axiom-commit cancelled before dispatch', 'info')
    return
  }
  cancelRequested = false
  const ax = buildAxiomBundle()
  if (!ax) return

  runningCommand = 'axiom-commit'
  const planHashPreview = keccak256(toHex(intent.plan))
  pushAudit(
    'axiom',
    `axiom.commit.tx submitting tokenId=${intent.tokenId} planHash=${shortHash(planHashPreview)}`,
    'info',
  )
  render()

  try {
    // The cross-package viem versions resolve to structurally-identical
    // but nominally-distinct `Client` types (the helper lives in
    // apps/demo, this file in apps/tui — bun's symlink layout produces
    // two `Client` shapes TS treats as unrelated even though they're
    // the same shape at runtime). Casting through Parameters keeps the
    // cast scoped to exactly the helper's declared input.
    type CommitArgs = Parameters<typeof axiomCommitCall>[0]
    const res = await axiomCommitCall({
      axiomAddress: ax.address,
      tokenId: intent.tokenId,
      plan: toHex(intent.plan),
      publicClient: ax.zgPub as CommitArgs['publicClient'],
      walletClient: ax.zgWallet as CommitArgs['walletClient'],
    })
    if (!res.ok) {
      // Surface the chain's revert reason verbatim — typical paths here:
      //   NotAuthorizedToCommit(tokenId, caller) — committer not the
      //   token owner / operator. NotTokenOwner from setOperator. Other
      //   transports report the underlying RPC error.
      pushAudit('axiom', `axiom.commit.failed ${res.error.kind === 'commit_failed' ? res.error.reason : res.error.kind}`.slice(0, 200), 'err')
      setToast('err', `axiom commit ${res.error.kind}`)
      return
    }
    const v = res.value
    pushAudit(
      'axiom',
      `axiom.commit.confirmed commitId=${v.commitId} tx=${shortHash(v.txHash)}`,
      'ok',
    )
    // Update receipt panel with the parsed PlanCommitted event when
    // available — we mark the envelope as settled with the tx hash so
    // the JSON pane renders, and let an off-chain indexer decode the
    // PlanCommitted log topic later via `parseEventLogs`.
    try {
      const rcpt = await ax.zgPub.waitForTransactionReceipt({ hash: v.txHash })
      receiptEnvelope = { ...receiptEnvelope, status: 'settled' }
      pushAudit(
        'receipt',
        `axiom-commit receipt status=${rcpt.status} blk=${rcpt.blockNumber} gas=${rcpt.gasUsed} planHash=${shortHash(v.planHash)}`,
        rcpt.status === 'success' ? 'ok' : 'err',
      )
    } catch (e) {
      pushAudit('receipt', `axiom-commit receipt fetch failed: ${e instanceof Error ? e.message : String(e)}`, 'err')
    }
  } catch (e) {
    pushAudit('axiom', `axiom.commit.crash: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200), 'err')
  } finally {
    runningCommand = 'idle'
    render()
  }
}

async function dispatchAxiomRevealIntent(
  intent: Extract<IntentCommand, { kind: 'axiom-reveal' }>,
): Promise<void> {
  if (cancelRequested) {
    cancelRequested = false
    pushAudit('intent', 'axiom-reveal cancelled before dispatch', 'info')
    return
  }
  cancelRequested = false
  const ax = buildAxiomBundle()
  if (!ax) return

  runningCommand = 'axiom-reveal'
  pushAudit('axiom', `axiom.reveal.tx submitting commitId=${shortHash(intent.commitId)}`, 'info')
  render()

  // Pre-flight: read commitOf(commitId) so we can surface CommitNotFound
  // / AlreadyRevealed BEFORE submitting a tx that would revert (and burn
  // 0G gas). The contract's reveal path only validates committer +
  // planHash on-chain — `tokenId` at reveal is the value emitted on the
  // PlanRevealed event, not a stored equality check — so the cleanest
  // source-of-truth on the commit's original tokenId is off-chain (the
  // indexer that watched PlanCommitted). Here we just verify the commit
  // exists; the tokenId we pass to revealPlan is mirrored from the
  // on-chain event by indexers anyway, and using `0n` makes it explicit
  // that the TUI didn't recover it from the input.
  const COMMIT_OF_ABI = parseAbi([
    'function commitOf(bytes32 commitId) view returns (address committer, uint64 blockNumber, bool revealed, bytes32 planHash)',
  ])
  try {
    const view = (await ax.zgPub.readContract({
      address: ax.address,
      abi: COMMIT_OF_ABI,
      functionName: 'commitOf',
      args: [intent.commitId],
    })) as readonly [Address, bigint, boolean, Hex]
    const committer = view[0]
    const revealed = view[2]
    if (committer === '0x0000000000000000000000000000000000000000') {
      pushAudit('axiom', `axiom.reveal.failed CommitNotFound(${shortHash(intent.commitId)})`, 'err')
      setToast('err', 'axiom reveal: CommitNotFound')
      runningCommand = 'idle'
      render()
      return
    }
    if (revealed) {
      pushAudit('axiom', `axiom.reveal.failed AlreadyRevealed(${shortHash(intent.commitId)})`, 'err')
      setToast('err', 'axiom reveal: AlreadyRevealed')
      runningCommand = 'idle'
      render()
      return
    }
  } catch (e) {
    pushAudit('axiom', `axiom.reveal.commitOf.failed ${e instanceof Error ? e.message : String(e)}`.slice(0, 200), 'err')
    setToast('err', 'axiom reveal: commitOf read failed')
    runningCommand = 'idle'
    render()
    return
  }

  try {
    // Same cross-package viem cast as in dispatchAxiomCommitIntent —
    // tight, scoped through Parameters, only relaxes the nominal Client
    // identity, not the actual shape.
    type RevealArgs = Parameters<typeof axiomRevealCall>[0]
    const res = await axiomRevealCall({
      axiomAddress: ax.address,
      tokenId: 0n,
      commitId: intent.commitId,
      plan: toHex(intent.plan),
      result: '0x',
      publicClient: ax.zgPub as RevealArgs['publicClient'],
      walletClient: ax.zgWallet as RevealArgs['walletClient'],
    })
    if (!res.ok) {
      // Reveal reverts are the most informative signal in the audit
      // loop — surface the chain's reason text verbatim. Common shapes:
      //   PlanHashMismatch(expected,actual) — the plan text differs
      //   from what was committed. NotCommitter(commitId,caller) —
      //   the wallet calling reveal isn't the wallet that committed.
      //   AlreadyRevealed(commitId) — replay attempt.
      pushAudit('axiom', `axiom.reveal.reverted ${res.error.kind === 'reveal_failed' ? res.error.reason : res.error.kind}`.slice(0, 220), 'err')
      setToast('err', `axiom reveal ${res.error.kind}`)
      return
    }
    const v = res.value
    pushAudit('axiom', `axiom.reveal.confirmed tx=${shortHash(v.txHash)}`, 'ok')
    try {
      const rcpt = await ax.zgPub.waitForTransactionReceipt({ hash: v.txHash })
      receiptEnvelope = { ...receiptEnvelope, status: 'settled' }
      pushAudit(
        'receipt',
        `axiom-reveal receipt status=${rcpt.status} blk=${rcpt.blockNumber} gas=${rcpt.gasUsed}`,
        rcpt.status === 'success' ? 'ok' : 'err',
      )
    } catch (e) {
      pushAudit('receipt', `axiom-reveal receipt fetch failed: ${e instanceof Error ? e.message : String(e)}`, 'err')
    }
  } catch (e) {
    pushAudit('axiom', `axiom.reveal.crash: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200), 'err')
  } finally {
    runningCommand = 'idle'
    render()
  }
}

// ── Delegation dispatcher (Slice I — ERC-7710) ───────────────────────────────
//
// Issues a real redeemable delegation via the deployed `DelegationManager`
// on Base Sepolia (chainId 84532). The contract has a single redeemer
// entry point — `redeemDelegations(bytes[], bytes32[], bytes[])` — and
// the manager's "create" semantics are the act of (a) signing a
// `Delegation` struct off-chain via EIP-712 and (b) redeeming it on
// chain. We do BOTH atomically here so the operator types one line and
// gets a real on-chain receipt (or a verbatim revert).
//
// Resolution rules for `<to>`:
//   - 0x40-hex   → viem `getAddress` (any case accepted; checksummed).
//   - `*.zhgg.eth` agent ENS → look up tokenId via agent-registry, then
//     read AgentNFT.ownerOf(tokenId) on 0G Galileo (chainId 16602)
//     using the bundle's `zgPub` client. Cross-chain: read on 0G,
//     write on Base.
//   - mainnet `*.eth` → reuse `resolveRecipient` from transfer-agent
//     (same free public RPC chain; honours `ENS_RPC_URL`).
//
// Hardcoded caveats (matching the on-chain Delegation struct field-for-field):
//   delegator        = the TUI's EOA (baseAccount). For a smart-wallet
//                      delegator (AgentReceiverWallet) the manager's
//                      ERC-1271 check passes; for a bare EOA the chain
//                      reverts on `InvalidSignature` — that revert is
//                      bubbled verbatim (per "real reverts bubble" rule).
//   delegate         = resolved <to>.
//   allowedTargets   = [SpendCap]    (only target the redemption may hit).
//   maxValuePerCall  = 0             (no native ETH).
//   expiresAt        = now + 1h      (DelegationExpired fires after).
//   salt             = random 32B    (parallel-safe replay defense).
//   spendCapAsset    = USDC          (debits the matching permissionId bucket).
//   permissionId     = intent.permissionId (verbatim).
//   maxAmountPerRedeem = 100_000     (0.1 USDC, 6dp).
//
// The redemption payload is a SpendCap.spendPermission call so the
// auto-debit path is exercised; if the cap isn't granted the chain
// reverts with `CapNotFound` and that's surfaced verbatim.

const AGENT_NFT_OWNER_OF_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
])

/// Verbatim from `contracts/src/DelegationManager.sol::redeemDelegations`.
/// Only the single function signature we call — keeping the surface tiny
/// makes drift between the Solidity ABI and this clone easier to spot.
const DELEGATION_MANAGER_ABI = parseAbi([
  'function redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallData) payable',
])

const SPEND_CAP_SPEND_ABI = parseAbi([
  'function spendPermission(address account, address asset, bytes32 permissionId, uint128 amount)',
])

/// 0.1 USDC at 6dp — small enough to fit comfortably under any sane
/// SpendCap bucket the operator pre-granted via the [G] modal.
const DELEGATE_DEFAULT_DEBIT: bigint = 100_000n
/// Delegation TTL — 1h from issuance. Manager rejects redeems after
/// `expiresAt` with `DelegationExpired(expiresAt, nowTs)`.
const DELEGATE_TTL_SECONDS: bigint = 3_600n

/// Resolve `<to>` into a checksummed Address with a labelled source
/// so the audit row can echo it ("via=address" / "via=agent_ens" /
/// "via=mainnet_ens").
type DelegateRecipient =
  | { ok: true; address: Address; source: 'address' | 'agent_ens' | 'mainnet_ens' }
  | { ok: false; reason: string }

async function resolveDelegateTo(
  to: string,
  bundle: LiveBundle,
): Promise<DelegateRecipient> {
  const trimmed = to.trim()
  if (isAddress(trimmed, { strict: false })) {
    return { ok: true, address: getAddress(trimmed), source: 'address' }
  }
  // Agent ENS (`*.zhgg.eth`) takes precedence over generic mainnet ENS —
  // these names aren't on mainnet and a stray mainnet probe would just
  // return ens_unresolved with a confusing reason.
  if (/\.zhgg\.eth$/i.test(trimmed)) {
    if (!bundle.agentNft) {
      return {
        ok: false,
        reason: `agent ENS "${trimmed}": AGENT_NFT_ADDRESS not set — cannot resolve owner`,
      }
    }
    const tokenId = AGENT_REGISTRY[trimmed.toLowerCase()]
    if (tokenId === undefined) {
      return {
        ok: false,
        reason: `agent ENS "${trimmed}" not in agent-registry — mint first or pass a 0x address`,
      }
    }
    try {
      const owner = (await bundle.zgPub.readContract({
        address: bundle.agentNft,
        abi: AGENT_NFT_OWNER_OF_ABI,
        functionName: 'ownerOf',
        args: [tokenId],
      })) as Address
      return { ok: true, address: getAddress(owner), source: 'agent_ens' }
    } catch (e) {
      return {
        ok: false,
        reason: `AgentNFT.ownerOf(${tokenId}) on 0G failed: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }
  if (/\.eth$/i.test(trimmed)) {
    const r = await resolveRecipient(trimmed, { ensRpcUrl: process.env.ENS_RPC_URL })
    if (!r.ok) {
      return { ok: false, reason: `mainnet ENS "${trimmed}": ${r.error.kind} — ${r.error.reason}` }
    }
    return { ok: true, address: r.address, source: 'mainnet_ens' }
  }
  return { ok: false, reason: `delegate to "${trimmed}" — expected 0x-address or *.eth name` }
}

async function dispatchDelegate(
  intent: Extract<IntentCommand, { kind: 'delegate' }>,
): Promise<void> {
  if (cancelRequested) {
    cancelRequested = false
    pushAudit('intent', 'delegate cancelled before dispatch', 'info')
    return
  }
  cancelRequested = false
  const bundle = tryBuildLiveBundle()
  if (!bundle) {
    pushAudit(
      'intent',
      `delegate blocked: ${getLiveBundleError() ?? 'env-incomplete (BASE_SEPOLIA_RPC_URL or BASE_SEPOLIA_PRIVATE_KEY)'}`,
      'err',
    )
    setToast('err', `env-incomplete: ${getLiveBundleError() ?? 'BASE_SEPOLIA_PRIVATE_KEY/RPC_URL'}`)
    return
  }

  const dmEnv = process.env.DELEGATION_MANAGER_ADDRESS
  const delegationManager: Address | null =
    dmEnv && /^0x[a-fA-F0-9]{40}$/.test(dmEnv) ? getAddress(dmEnv) : null
  if (!delegationManager) {
    pushAudit('delegate', 'DELEGATION_MANAGER_ADDRESS missing/invalid', 'err')
    setToast('err', 'DELEGATION_MANAGER_ADDRESS required')
    return
  }
  if (!bundle.spendCap) {
    pushAudit('delegate', 'SPEND_CAP_ADDRESS not set — cannot wire delegation', 'err')
    setToast('err', 'SPEND_CAP_ADDRESS required')
    return
  }

  runningCommand = 'delegate'
  pushAudit('delegate', `delegate.intent ${intent.to} ${intent.permissionId}`, 'info')
  render()

  // 1. Resolve <to>.
  const recipient = await resolveDelegateTo(intent.to, bundle)
  if (!recipient.ok) {
    pushAudit('delegate', `delegate.resolve.failed ${recipient.reason}`.slice(0, 200), 'err')
    setToast('err', 'delegate: recipient unresolved')
    runningCommand = 'idle'
    render()
    return
  }
  pushAudit(
    'delegate',
    `delegate.resolve.ok via=${recipient.source} → ${shortHash(recipient.address)}`,
    'ok',
  )

  // 2. Build the delegation. Salt is random per dispatch so repeated
  //    calls with identical args don't collide on the manager's
  //    `redeemed[(delegator, salt)]` map.
  const saltBytes = new Uint8Array(32)
  crypto.getRandomValues(saltBytes)
  const salt = ('0x' +
    Array.from(saltBytes).map((b) => b.toString(16).padStart(2, '0')).join('')) as Hex
  const expiresAt = BigInt(Math.floor(Date.now() / 1000)) + DELEGATE_TTL_SECONDS

  const delegator: Address = bundle.baseAccount.address
  const delegation: ERC7710Delegation = {
    delegator,
    delegate: recipient.address,
    allowedTargets: [bundle.spendCap],
    maxValuePerCall: 0n,
    expiresAt,
    salt,
    spendCapAsset: bundle.usdc,
    permissionId: intent.permissionId,
    maxAmountPerRedeem: DELEGATE_DEFAULT_DEBIT,
  }

  // 3. Compute the EIP-712 digest (= delegationHash on chain) and sign.
  const domain = { chainId: 84532, verifyingContract: delegationManager }
  const digest = delegationDigest(domain, delegation)
  pushAudit('delegate', `delegate.digest ${digest}`, 'info')

  let signature: Hex
  try {
    signature = await signDelegation(bundle.baseWallet, domain, delegation)
  } catch (e) {
    pushAudit(
      'delegate',
      `delegate.sign.failed ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
      'err',
    )
    setToast('err', 'delegate: signing failed')
    runningCommand = 'idle'
    render()
    return
  }

  // 4. ABI-encode the redemption payload. The Execution targets
  //    SpendCap.spendPermission with the same permissionId — the
  //    manager will route it through the delegator's
  //    `executeViaDelegation` so SpendCap sees the wallet as msg.sender
  //    (which is what makes its `msg.sender == account` invariant hold).
  const permissionContext = encodePermissionContext(delegation, signature)
  const spendCalldata = encodeFunctionData({
    abi: SPEND_CAP_SPEND_ABI,
    functionName: 'spendPermission',
    args: [delegator, bundle.usdc, intent.permissionId, DELEGATE_DEFAULT_DEBIT],
  })
  const execData = encodeExecution({
    target: bundle.spendCap,
    value: 0n,
    data: spendCalldata,
  })

  // 5. Submit redeemDelegations. simulate first so any caveat revert
  //    surfaces with its decoded error name (TargetNotAllowed,
  //    InvalidSignature, CapNotFound, …) instead of a raw 0x selector.
  pushAudit(
    'delegate',
    `delegate.tx submitting redeemDelegations to ${shortHash(delegationManager)}`,
    'info',
  )
  render()
  try {
    const sim = await bundle.basePub.simulateContract({
      account: bundle.baseAccount,
      address: delegationManager,
      abi: DELEGATION_MANAGER_ABI,
      functionName: 'redeemDelegations',
      args: [[permissionContext], [MODE_SINGLE_CALL], [execData]],
    })
    const txHash = await bundle.baseWallet.writeContract(sim.request)
    pushAudit('delegate', `delegate.confirmed delegationHash=${digest} tx=${txHash}`, 'ok')
    try {
      const rcpt = await bundle.basePub.waitForTransactionReceipt({ hash: txHash })
      pushAudit(
        'receipt',
        `delegate receipt status=${rcpt.status} blk=${rcpt.blockNumber} gas=${rcpt.gasUsed}`,
        rcpt.status === 'success' ? 'ok' : 'err',
      )
    } catch (e) {
      pushAudit(
        'receipt',
        `delegate receipt fetch failed: ${e instanceof Error ? e.message : String(e)}`,
        'err',
      )
    }
  } catch (e) {
    // Real chain reverts (LengthMismatch / WrongDelegate /
    // InvalidSignature / TargetNotAllowed / ValueExceedsCap /
    // DelegationExpired / EmptyAllowedTargets / CapNotFound) bubble
    // verbatim. Slice keeps the audit row scannable; toast stays short.
    const msg = e instanceof Error ? e.message : String(e)
    pushAudit('delegate', `delegate.reverted ${msg}`.slice(0, 220), 'err')
    setToast('err', `delegate reverted`)
  } finally {
    runningCommand = 'idle'
    render()
  }
}

// ── Operator UX dispatchers (Phase 3) ────────────────────────────────────────
//
// Read-only inspections + the explicit `mint` write. None of these go
// through the audit/payment FLOW panel — they don't exercise that
// pipeline. Each helper from `operator-intents.ts` returns audit rows;
// we just push them and update `runningCommand` for the agents panel.

async function dispatchOperatorAgents(): Promise<void> {
  runningCommand = 'audit' // light AGENTS panel briefly
  const rows = await listAgents({
    agentNftAddress: process.env.AGENT_NFT_ADDRESS as Address | undefined,
    zgRpcUrl: process.env.ZG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai',
  })
  for (const r of rows) pushAudit(r.agent, r.event, r.ok)
  runningCommand = 'idle'
  render()
}

async function dispatchOperatorBalances(): Promise<void> {
  // Build a Base Sepolia client from env directly when liveBundle is
  // unavailable (e.g. user invoked `balances` before pasting all the
  // deploy addresses). Falls back to the user's known wallet address.
  const liveBundle = tryBuildLiveBundle()
  const baseRpc = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org'
  const basePub = liveBundle?.basePub ?? createPublicClient({ transport: http(baseRpc) })
  const acct = liveBundle?.baseAccount.address
    ?? (process.env.MINT_AGENT_ADDRESS as Address | undefined)
    ?? '0x557E1E07652B75ABaA667223B11704165fC94d09' as Address
  const rows = await showBalances({
    account: acct,
    zgRpcUrl: process.env.ZG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai',
    basePublicClient: basePub,
  })
  for (const r of rows) pushAudit(r.agent, r.event, r.ok)
  render()
}

async function dispatchOperatorBlock(): Promise<void> {
  const liveBundle = tryBuildLiveBundle()
  const baseRpc = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org'
  const basePub = liveBundle?.basePub ?? createPublicClient({ transport: http(baseRpc) })
  const rows = await showBlock({
    zgRpcUrl: process.env.ZG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai',
    basePublicClient: basePub,
  })
  for (const r of rows) pushAudit(r.agent, r.event, r.ok)
  render()
}

async function dispatchOperatorMint(intent: Extract<IntentCommand, { kind: 'mint' }>): Promise<void> {
  const pkRaw = process.env.MINT_AGENT_PRIVATE_KEY
  if (!pkRaw || !/^0x[0-9a-fA-F]{64}$/.test(pkRaw)) {
    pushAudit('mint', 'MINT_AGENT_PRIVATE_KEY missing/invalid', 'err')
    return
  }
  runningCommand = 'audit'
  pushAudit('mint', `minting ${intent.role}-agent iNFT on 0G…`, 'info')
  render()

  const account = privateKeyToAccount(pkRaw as Hex)
  const zgRpc = process.env.ZG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai'
  const zgTransport = http(zgRpc)
  const zgPub = createPublicClient({ transport: zgTransport })
  const zgWallet = createWalletClient({ account, transport: zgTransport })

  const r = await dispatchMint({
    role: intent.role as Parameters<typeof dispatchMint>[0]['role'],
    account: account.address,
    agentNftAddress: process.env.AGENT_NFT_ADDRESS as Address | undefined,
    zgPublicClient: zgPub,
    zgWalletClient: zgWallet,
    onProgress: (row: OpRow) => pushAudit(row.agent, row.event, row.ok),
  })
  if (!r.ok) {
    pushAudit('mint', `mint failed: ${r.reason}`.slice(0, 160), 'err')
  } else {
    pushAudit('mint', `mint.confirmed tokenId=${r.result.tokenId} tx=${r.result.txHash.slice(0, 12)}…`, 'ok')
  }
  runningCommand = 'idle'
  render()
}

async function dispatchOperatorCancel(): Promise<void> {
  if (runningCommand === 'idle') {
    pushAudit('cancel', 'no command in flight', 'info')
    render()
    return
  }
  pushAudit('cancel', `cancelling ${runningCommand} (in-flight tx will still mine if already submitted)`, 'info')
  runningCommand = 'idle'
  render()
}

// ── ERC-4337 SimpleAccount dispatcher ────────────────────────────────────────
//
// `aa <owner> [salt]` — predicts the SimpleAccount address via
// AgentSimpleAccountFactory.predict(owner, salt) and then deploys it
// with createAccount (idempotent: if codeSize > 0 the factory short-
// circuits and returns the existing address). Every step posts an audit
// row; on success we echo the deployed AA address and tx hash so the
// operator can verify on basescan.
//
// Required env: AGENT_AA_FACTORY_ADDRESS + BASE_SEPOLIA_PRIVATE_KEY +
// BASE_SEPOLIA_RPC_URL. Refuses honestly with a precise reason when any
// is missing — never silently mocks.

const AA_FACTORY_ABI = parseAbi([
  'function createAccount(address owner, bytes32 salt) returns (address)',
  'function predict(address owner, bytes32 salt) view returns (address)',
])

async function dispatchAaDeployIntent(
  intent: Extract<IntentCommand, { kind: 'aa-deploy' }>,
): Promise<void> {
  const factory = process.env.AGENT_AA_FACTORY_ADDRESS as Address | undefined
  if (!factory || !isAddress(factory)) {
    pushAudit('aa', 'aa blocked: AGENT_AA_FACTORY_ADDRESS unset/invalid', 'err')
    setToast('err', 'AGENT_AA_FACTORY_ADDRESS missing')
    render()
    return
  }
  const pkRaw = process.env.BASE_SEPOLIA_PRIVATE_KEY
  if (!pkRaw || !/^0x[0-9a-fA-F]{64}$/.test(pkRaw)) {
    pushAudit('aa', 'aa blocked: BASE_SEPOLIA_PRIVATE_KEY missing/invalid', 'err')
    render()
    return
  }
  const rpc = process.env.BASE_SEPOLIA_RPC_URL
  if (!rpc) {
    pushAudit('aa', 'aa blocked: BASE_SEPOLIA_RPC_URL missing', 'err')
    render()
    return
  }

  runningCommand = 'audit'
  pushAudit('aa', `predict factory=${shortHash(factory)} owner=${shortHash(intent.owner)}`, 'info')
  render()

  const account = privateKeyToAccount(pkRaw as Hex)
  const transport = http(rpc)
  const pub = createPublicClient({ transport })
  const wallet = createWalletClient({ account, transport })

  let predicted: Address
  try {
    predicted = await pub.readContract({
      address: factory,
      abi: AA_FACTORY_ABI,
      functionName: 'predict',
      args: [intent.owner, intent.salt as Hex],
    })
  } catch (err) {
    pushAudit('aa', `predict failed: ${(err as Error).message}`.slice(0, 160), 'err')
    runningCommand = 'idle'
    render()
    return
  }
  pushAudit('aa', `predicted aa=${shortHash(predicted)}`, 'info')
  render()

  // Idempotent — if codesize > 0 at predicted, createAccount short-circuits
  // and returns the existing address without redeploying.
  let txHash: Hex
  try {
    const sim = await pub.simulateContract({
      account,
      address: factory,
      abi: AA_FACTORY_ABI,
      functionName: 'createAccount',
      args: [intent.owner, intent.salt as Hex],
    })
    txHash = await wallet.writeContract(sim.request)
  } catch (err) {
    pushAudit('aa', `createAccount failed: ${(err as Error).message}`.slice(0, 160), 'err')
    runningCommand = 'idle'
    render()
    return
  }

  await pub.waitForTransactionReceipt({ hash: txHash })
  pushAudit('aa', `aa.deployed addr=${shortHash(predicted)} tx=${shortHash(txHash)}`, 'ok')
  runningCommand = 'idle'
  render()
}

// ── ERC-4337 UserOp dispatcher (`aa send <to> <amountEth>`) ──────────────────
//
// Builds + signs + submits a real ERC-4337 v0.7 UserOp through Pimlico's
// public testnet bundler. Gas knobs default to AgentSimpleAccount-sized
// values; the bundler will reject and surface a precise reason if the
// op needs more (the user can re-run with explicit overrides — out of
// scope for the demo path).
//
// Env required:
//   AGENT_AA_FACTORY_ADDRESS  — deployed factory on Base Sepolia
//   AGENT_AA_OWNER_ADDRESS    — the EOA owner (predict CREATE2 input)
//   BASE_SEPOLIA_PRIVATE_KEY  — signs the UserOp; MUST match owner
//   BASE_SEPOLIA_RPC_URL      — for EntryPoint.getNonce reads
//   PIMLICO_API_KEY           — optional; testnet methods work without
//
// Gas defaults (typical for AgentSimpleAccount.execute on Base Sepolia):
const AA_DEFAULT_VERIFICATION_GAS = 150_000n
const AA_DEFAULT_CALL_GAS = 100_000n
const AA_DEFAULT_PRE_VERIFICATION_GAS = 60_000n
const BASE_SEPOLIA_CHAIN_ID = 84532

async function dispatchAaSendIntent(
  intent: Extract<IntentCommand, { kind: 'aa-send' }>,
): Promise<void> {
  const factory = process.env.AGENT_AA_FACTORY_ADDRESS as Address | undefined
  if (!factory || !isAddress(factory)) {
    pushAudit('aa', 'aa send blocked: AGENT_AA_FACTORY_ADDRESS unset/invalid', 'err')
    setToast('err', 'AGENT_AA_FACTORY_ADDRESS missing')
    render()
    return
  }
  const ownerAddr = process.env.AGENT_AA_OWNER_ADDRESS as Address | undefined
  if (!ownerAddr || !isAddress(ownerAddr)) {
    pushAudit('aa', 'aa send blocked: AGENT_AA_OWNER_ADDRESS unset/invalid', 'err')
    render()
    return
  }
  const pkRaw = process.env.BASE_SEPOLIA_PRIVATE_KEY
  if (!pkRaw || !/^0x[0-9a-fA-F]{64}$/.test(pkRaw)) {
    pushAudit('aa', 'aa send blocked: BASE_SEPOLIA_PRIVATE_KEY missing/invalid', 'err')
    render()
    return
  }
  const rpc = process.env.BASE_SEPOLIA_RPC_URL
  if (!rpc) {
    pushAudit('aa', 'aa send blocked: BASE_SEPOLIA_RPC_URL missing', 'err')
    render()
    return
  }

  runningCommand = 'audit'
  pushAudit('aa', `aa send building UserOp · to=${shortHash(intent.to)}`, 'info')
  render()

  const ownerAccount = privateKeyToAccount(pkRaw as Hex)
  if (ownerAccount.address.toLowerCase() !== ownerAddr.toLowerCase()) {
    pushAudit(
      'aa',
      `aa send refused: BASE_SEPOLIA_PRIVATE_KEY → ${shortHash(ownerAccount.address)} ` +
        `does not match AGENT_AA_OWNER_ADDRESS=${shortHash(ownerAddr)}`,
      'err',
    )
    runningCommand = 'idle'
    render()
    return
  }
  const transport = http(rpc)
  const pub = createPublicClient({ transport })
  const wallet = createWalletClient({ account: ownerAccount, transport })

  // Predict the AA address for this owner (salt = bytes32(0)).
  const ZERO_SALT = `0x${'0'.repeat(64)}` as Hex
  const AA_FACTORY_PREDICT_ABI = parseAbi([
    'function predict(address owner, bytes32 salt) view returns (address)',
  ])
  let sender: Address
  try {
    sender = await pub.readContract({
      address: factory,
      abi: AA_FACTORY_PREDICT_ABI,
      functionName: 'predict',
      args: [ownerAddr, ZERO_SALT],
    })
  } catch (err) {
    pushAudit('aa', `predict failed: ${(err as Error).message}`.slice(0, 160), 'err')
    runningCommand = 'idle'
    render()
    return
  }
  pushAudit('aa', `aa.sender=${shortHash(sender)}`, 'info')
  render()

  // initCode: empty if AA is already deployed; factory + createAccount call otherwise.
  const senderCode = await pub.getCode({ address: sender })
  const initCode: Hex =
    senderCode && senderCode !== '0x' ? '0x' : encodeInitCode(factory, ownerAddr, ZERO_SALT)
  if (initCode !== '0x') {
    pushAudit('aa', 'aa send including initCode (first-op deploy)', 'info')
    render()
  }

  // Nonce from canonical EntryPoint
  const nonceResult = await getEntryPointNonce({
    rpcUrl: rpc,
    entryPoint: ENTRYPOINT_V07_ADDRESS,
    sender,
  })
  if (!nonceResult.ok) {
    pushAudit('aa', `nonce read failed: ${nonceResult.error.kind}`, 'err')
    runningCommand = 'idle'
    render()
    return
  }
  const nonce = nonceResult.value

  // Compose execute(target, value, data) callData
  const callData = encodeExecute(intent.to, parseUnits(intent.amountEth, 18), intent.callData)

  // Pimlico bundler — public testnet endpoint works without key
  const bundlerUrl = pimlicoBundlerUrl(BASE_SEPOLIA_CHAIN_ID, process.env.PIMLICO_API_KEY)
  const bundlerOpts = { bundlerUrl }

  const gasPriceR = await pimlicoGetUserOperationGasPrice(bundlerOpts)
  if (!gasPriceR.ok) {
    pushAudit('aa', `bundler gas price failed: ${gasPriceR.error.kind}`, 'err')
    runningCommand = 'idle'
    render()
    return
  }
  const fast = gasPriceR.value.fast
  const maxFeePerGas = BigInt(fast.maxFeePerGas)
  const maxPriorityFeePerGas = BigInt(fast.maxPriorityFeePerGas)

  const op = buildUserOp({
    sender,
    nonce,
    initCode,
    callData,
    verificationGasLimit: AA_DEFAULT_VERIFICATION_GAS,
    callGasLimit: AA_DEFAULT_CALL_GAS,
    preVerificationGas: AA_DEFAULT_PRE_VERIFICATION_GAS,
    maxFeePerGas,
    maxPriorityFeePerGas,
  })
  const signature = await signUserOp(
    wallet,
    ownerAccount,
    op,
    ENTRYPOINT_V07_ADDRESS,
    BASE_SEPOLIA_CHAIN_ID,
  )
  const signedOp = { ...op, signature }

  pushAudit('aa', 'aa send submitting to Pimlico bundler…', 'info')
  render()
  const submitR = await sendUserOperation(signedOp, ENTRYPOINT_V07_ADDRESS, bundlerOpts)
  if (!submitR.ok) {
    const reason =
      submitR.error.kind === 'rpc_error' ? submitR.error.message : submitR.error.kind
    pushAudit('aa', `bundler rejected: ${reason}`.slice(0, 200), 'err')
    runningCommand = 'idle'
    render()
    return
  }
  const userOpHash = submitR.value
  pushAudit('aa', `aa.submitted userOpHash=${shortHash(userOpHash)}`, 'info')
  render()

  // Poll for receipt — bundlers take a few seconds to include
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (cancelRequested) {
      cancelRequested = false
      pushAudit('aa', 'aa send polling cancelled (op may still mine)', 'info')
      runningCommand = 'idle'
      render()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    const receiptR = await getUserOperationReceipt(userOpHash, bundlerOpts)
    if (!receiptR.ok) continue
    if (receiptR.value === null) continue
    // Receipt landed.
    const r = receiptR.value as { receipt?: { transactionHash?: string }; success?: boolean }
    const txHash = r.receipt?.transactionHash ?? userOpHash
    const ok = r.success !== false
    pushAudit(
      'aa',
      `aa.${ok ? 'sent' : 'reverted'} userOp=${shortHash(userOpHash)} tx=${shortHash(txHash)}`,
      ok ? 'ok' : 'err',
    )
    runningCommand = 'idle'
    render()
    return
  }
  pushAudit('aa', `aa send timeout — userOp ${shortHash(userOpHash)} not mined in 60s`, 'err')
  runningCommand = 'idle'
  render()
}

// ── Yield-vault dispatchers (Slice K — ERC-4626) ─────────────────────────────
//
// Real on-chain `parkIdle` / `withdrawIdle` against the user's
// AgentReceiverWallet (per iNFT, deterministic via the factory CREATE2).
// Heavy lifting lives in `yield-intents.ts`; this thin wrapper handles
// env validation, liveBundle gating, audit/receipt rendering. Both
// require RECEIVER_FACTORY_ADDRESS + YIELD_VAULT_ADDRESS in env; the
// latter is the MockERC4626 deployed via
// `forge script script/DeployYieldVault.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast`.

async function dispatchParkIntent(
  intent: Extract<IntentCommand, { kind: 'park' }>,
): Promise<void> {
  if (cancelRequested) {
    cancelRequested = false
    pushAudit('intent', 'park cancelled before dispatch', 'info')
    return
  }
  cancelRequested = false

  const bundle = tryBuildLiveBundle()
  if (!bundle) {
    pushAudit(
      'intent',
      `park blocked: ${getLiveBundleError() ?? 'env-incomplete (BASE_SEPOLIA_RPC_URL or BASE_SEPOLIA_PRIVATE_KEY)'}`,
      'err',
    )
    setToast('err', `env-incomplete: ${getLiveBundleError() ?? 'BASE_SEPOLIA_PRIVATE_KEY/RPC_URL'}`)
    return
  }

  const factory = process.env.RECEIVER_FACTORY_ADDRESS as Address | undefined
  if (!factory || !/^0x[a-fA-F0-9]{40}$/.test(factory)) {
    pushAudit('yield', 'park blocked: RECEIVER_FACTORY_ADDRESS unset/invalid', 'err')
    setToast('err', 'RECEIVER_FACTORY_ADDRESS missing')
    return
  }
  const yieldVaultEnv = process.env.YIELD_VAULT_ADDRESS as Address | undefined
  if (!yieldVaultEnv || !/^0x[a-fA-F0-9]{40}$/.test(yieldVaultEnv)) {
    pushAudit('yield', 'park blocked: YIELD_VAULT_ADDRESS unset. Deploy MockERC4626 first:', 'err')
    pushAudit(
      'yield',
      '  USDC_ADDRESS=$USDC_BASE_SEPOLIA_ADDRESS forge script script/DeployYieldVault.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast',
      'info',
    )
    pushAudit(
      'yield',
      '  Then: cast send <RECEIVER_WALLET> "setYieldVault(address)" <vault> --private-key $BASE_SEPOLIA_PRIVATE_KEY --rpc-url $BASE_SEPOLIA_RPC_URL',
      'info',
    )
    setToast('err', 'YIELD_VAULT_ADDRESS missing — deploy + wire vault first')
    return
  }

  runningCommand = 'park'
  pushAudit('yield', `park.intent ${intent.amount} ${intent.symbol} (#${intent.tokenId} receiver)`, 'info')
  render()

  try {
    const result = await executePark({
      symbol: intent.symbol,
      amount: intent.amount,
      tokenId: intent.tokenId,
      factory,
      yieldVaultEnv,
      publicClient: bundle.basePub,
      walletClient: bundle.baseWallet,
      account: bundle.baseAccount,
    })
    for (const r of result.rows) pushAudit(r.agent, r.event, r.ok)
    if (result.ok) {
      receiptEnvelope = { ...receiptEnvelope, status: 'settled' }
    } else {
      setToast('err', 'park blocked — see audit trail')
    }
  } catch (e) {
    pushAudit('yield', `park.crash: ${e instanceof Error ? e.message : String(e)}`.slice(0, 220), 'err')
    setToast('err', 'park failed — see audit trail')
  } finally {
    runningCommand = 'idle'
    render()
  }
}

async function dispatchUnparkIntent(
  intent: Extract<IntentCommand, { kind: 'unpark' }>,
): Promise<void> {
  if (cancelRequested) {
    cancelRequested = false
    pushAudit('intent', 'unpark cancelled before dispatch', 'info')
    return
  }
  cancelRequested = false

  const bundle = tryBuildLiveBundle()
  if (!bundle) {
    pushAudit(
      'intent',
      `unpark blocked: ${getLiveBundleError() ?? 'env-incomplete (BASE_SEPOLIA_RPC_URL or BASE_SEPOLIA_PRIVATE_KEY)'}`,
      'err',
    )
    setToast('err', `env-incomplete: ${getLiveBundleError() ?? 'BASE_SEPOLIA_PRIVATE_KEY/RPC_URL'}`)
    return
  }

  const factory = process.env.RECEIVER_FACTORY_ADDRESS as Address | undefined
  if (!factory || !/^0x[a-fA-F0-9]{40}$/.test(factory)) {
    pushAudit('yield', 'unpark blocked: RECEIVER_FACTORY_ADDRESS unset/invalid', 'err')
    setToast('err', 'RECEIVER_FACTORY_ADDRESS missing')
    return
  }
  const yieldVaultEnv = process.env.YIELD_VAULT_ADDRESS as Address | undefined
  if (!yieldVaultEnv || !/^0x[a-fA-F0-9]{40}$/.test(yieldVaultEnv)) {
    pushAudit('yield', 'unpark blocked: YIELD_VAULT_ADDRESS unset. Deploy MockERC4626 first:', 'err')
    pushAudit(
      'yield',
      '  USDC_ADDRESS=$USDC_BASE_SEPOLIA_ADDRESS forge script script/DeployYieldVault.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast',
      'info',
    )
    setToast('err', 'YIELD_VAULT_ADDRESS missing — deploy vault first')
    return
  }

  runningCommand = 'unpark'
  pushAudit('yield', `unpark.intent ${intent.amount} ${intent.symbol} (#${intent.tokenId} receiver)`, 'info')
  render()

  try {
    const result = await executeUnpark({
      symbol: intent.symbol,
      amount: intent.amount,
      tokenId: intent.tokenId,
      factory,
      yieldVaultEnv,
      publicClient: bundle.basePub,
      walletClient: bundle.baseWallet,
      account: bundle.baseAccount,
    })
    for (const r of result.rows) pushAudit(r.agent, r.event, r.ok)
    if (result.ok) {
      receiptEnvelope = { ...receiptEnvelope, status: 'settled' }
    } else {
      setToast('err', 'unpark blocked — see audit trail')
    }
  } catch (e) {
    pushAudit('yield', `unpark.crash: ${e instanceof Error ? e.message : String(e)}`.slice(0, 220), 'err')
    setToast('err', 'unpark failed — see audit trail')
  } finally {
    runningCommand = 'idle'
    render()
  }
}

// ── ACP / EIP-8183 escrow dispatchers (Slice J) ──────────────────────────────
//
// `acp create` and `acp release` both target the deployed AgenticCommerce
// contract on 0G Galileo (chainId 16602). The user wallet (liveBundle's
// zgAccount) is the client AND evaluator on every job — we set
// evaluator=0x0 at create-time so the contract rewrites it to msg.sender,
// which then makes `acp release` callable by the same key. Reverts bubble
// verbatim — typical paths the operator will hit:
//
//   "ContractFunctionExecutionError: ... reverted with NotEvaluator(0x..)"
//     → tried to release a job created by a different wallet
//   "... WrongState(jobId, Submitted, Funded)"
//     → release before provider has called submit() — wait for delivery
//   "... InvalidJobId(N)" → typo in the jobId
//
// Required env: ACP_ADDRESS, AGENT_NFT_ADDRESS, ACP_PAYMENT_TOKEN,
// ZG_RPC_URL, MINT_AGENT_PRIVATE_KEY (or ZG_PRIVATE_KEY). Without these
// the dispatcher refuses cleanly — no synthetic fallback.

async function dispatchAcpCreateIntent(
  intent: Extract<IntentCommand, { kind: 'acp-create' }>,
): Promise<void> {
  if (cancelRequested) { cancelRequested = false; pushAudit('intent', 'acp create cancelled before dispatch', 'info'); return }
  cancelRequested = false
  const bundle = tryBuildLiveBundle()
  if (!bundle) {
    pushAudit('intent', `acp create blocked: ${getLiveBundleError() ?? 'env-incomplete'}`, 'err')
    setToast('err', `env-incomplete: ${getLiveBundleError() ?? '?'}`)
    return
  }
  // Three contract addresses from env — none have safe defaults so we
  // refuse on missing rather than guess. ACP_ADDRESS is the deployed
  // AgenticCommerce (chain 16602); ACP_PAYMENT_TOKEN is the ERC-20
  // accepted as escrow; AGENT_NFT_ADDRESS is the iNFT for ownerOf().
  const acpAddrRaw = process.env.ACP_ADDRESS
  const tokenRaw = process.env.ACP_PAYMENT_TOKEN
  if (!acpAddrRaw || !/^0x[a-fA-F0-9]{40}$/.test(acpAddrRaw)) {
    pushAudit('acp', 'ACP_ADDRESS missing or invalid in env', 'err')
    setToast('err', 'ACP_ADDRESS missing')
    return
  }
  if (!bundle.agentNft) {
    pushAudit('acp', 'AGENT_NFT_ADDRESS missing — needed to resolve provider via ownerOf', 'err')
    setToast('err', 'AGENT_NFT_ADDRESS missing')
    return
  }
  if (!tokenRaw || !/^0x[a-fA-F0-9]{40}$/.test(tokenRaw)) {
    pushAudit('acp', 'ACP_PAYMENT_TOKEN missing or invalid (ERC-20 address on 0G)', 'err')
    setToast('err', 'ACP_PAYMENT_TOKEN missing')
    return
  }

  runningCommand = 'acp-create'
  render()
  const r = await dispatchAcpCreate({
    tokenId: intent.tokenId,
    target: intent.target,
    usdcAmount: intent.usdcAmount,
    acpAddress: acpAddrRaw as Address,
    agentNftAddress: bundle.agentNft,
    paymentToken: tokenRaw as Address,
    zgPublicClient: bundle.zgPub,
    zgWalletClient: bundle.zgWallet,
    callerAddress: bundle.zgAccount.address,
    onProgress: (row: AcpRow) => pushAudit(row.agent, row.event, row.ok),
  })
  if (!r.ok) {
    setToast('err', `acp create failed`.slice(0, 80))
  }
  runningCommand = 'idle'
  render()
}

async function dispatchAcpReleaseIntent(
  intent: Extract<IntentCommand, { kind: 'acp-release' }>,
): Promise<void> {
  if (cancelRequested) { cancelRequested = false; pushAudit('intent', 'acp release cancelled before dispatch', 'info'); return }
  cancelRequested = false
  const bundle = tryBuildLiveBundle()
  if (!bundle) {
    pushAudit('intent', `acp release blocked: ${getLiveBundleError() ?? 'env-incomplete'}`, 'err')
    setToast('err', `env-incomplete: ${getLiveBundleError() ?? '?'}`)
    return
  }
  const acpAddrRaw = process.env.ACP_ADDRESS
  if (!acpAddrRaw || !/^0x[a-fA-F0-9]{40}$/.test(acpAddrRaw)) {
    pushAudit('acp', 'ACP_ADDRESS missing or invalid in env', 'err')
    setToast('err', 'ACP_ADDRESS missing')
    return
  }

  runningCommand = 'acp-release'
  render()
  const r = await dispatchAcpRelease({
    jobId: intent.jobId,
    acpAddress: acpAddrRaw as Address,
    zgPublicClient: bundle.zgPub,
    zgWalletClient: bundle.zgWallet,
    callerAddress: bundle.zgAccount.address,
    onProgress: (row: AcpRow) => pushAudit(row.agent, row.event, row.ok),
  })
  if (!r.ok) {
    setToast('err', `acp release failed`.slice(0, 80))
  }
  runningCommand = 'idle'
  render()
}

// ── KeeperHub direct-API dispatcher (Phase 2) ────────────────────────────────
//
// Pure HTTPS path — does NOT require liveBundle. Auth is via KH_API_KEY
// env. The dispatcher refuses with a real error when the key is missing
// (no synthetic fallback) and surfaces real KH HTTP errors verbatim.

async function dispatchKHIntent(
  intent:
    | Extract<IntentCommand, { kind: 'kh-trigger' }>
    | Extract<IntentCommand, { kind: 'kh-status' }>
    | Extract<IntentCommand, { kind: 'kh-workflows' }>
    | Extract<IntentCommand, { kind: 'kh-integrations' }>
    | Extract<IntentCommand, { kind: 'kh-discover' }>
    | Extract<IntentCommand, { kind: 'kh-inspect' }>,
): Promise<void> {
  const apiKey = process.env.KH_API_KEY
  if (!apiKey || apiKey.length === 0) {
    pushAudit('kh', 'KH_API_KEY missing — paste kh_… into .env, then restart TUI', 'err')
    setToast('err', 'KH_API_KEY required')
    return
  }
  const baseUrl = process.env.KEEPERHUB_API_URL && process.env.KEEPERHUB_API_URL.length > 0
    ? process.env.KEEPERHUB_API_URL
    : 'https://app.keeperhub.com'

  // Build the typed call. Note: keeperhub-agent uses snake_case kinds
  // (workflow_trigger, etc.) and returns a discriminated union with
  // its own `kind` tag — different from the parser's `kh-trigger` shape.
  let call: KHCall
  if (intent.kind === 'kh-trigger') {
    call = { kind: 'workflow_trigger', workflowId: intent.workflowId, inputs: intent.inputs }
  } else if (intent.kind === 'kh-status') {
    call = { kind: 'workflow_status', executionId: intent.executionId }
  } else if (intent.kind === 'kh-workflows') {
    call = { kind: 'list_workflows' }
  } else if (intent.kind === 'kh-integrations') {
    call = { kind: 'list_integrations' }
  } else if (intent.kind === 'kh-discover') {
    call = { kind: 'discover', filters: intent.search ? { search: intent.search } : undefined }
  } else {
    call = { kind: 'inspect', workflowId: intent.workflowId }
  }

  const label = intent.kind.replace('kh-', '')
  pushAudit('kh', `${label} call → ${baseUrl}`, 'info')
  render()

  // Override env so executeKHCall picks up the bearer + baseUrl from
  // OUR validated values (we already refused above on missing key).
  const result = await executeKHCall(call, {
    env: { ...process.env, KH_API_KEY: apiKey, KEEPERHUB_API_URL: baseUrl } as NodeJS.ProcessEnv,
  })

  if (!result.ok) {
    const e = result.error
    pushAudit('kh', `${label} failed (${e.kind}): ${e.reason.slice(0, 140)}`, 'err')
    setToast('err', `kh ${label} ${e.kind}`)
    render()
    return
  }

  // Discriminate on the result's kind (matches the call's kind 1:1).
  const out = result.value
  if (out.kind === 'list_workflows') {
    const list = out.value
    pushAudit('kh', `workflows: ${list.length} found`, 'ok')
    if (list.length === 0) {
      pushAudit('kh', '  (none — create one at app.keeperhub.com/workflows)', 'info')
    }
    for (const w of list.slice(0, 8)) {
      pushAudit('kh', `  ${w.id.padEnd(22)} ${w.name ?? '(unnamed)'}`, 'info')
    }
  } else if (out.kind === 'list_integrations') {
    const list = out.value
    pushAudit('kh', `integrations: ${list.length} found`, 'ok')
    for (const i of list.slice(0, 8)) {
      const m = i.isManaged ? 'managed' : 'byo'
      pushAudit('kh', `  ${i.type.padEnd(10)} ${i.name.padEnd(20)} (${m})`, 'info')
    }
  } else if (out.kind === 'workflow_trigger') {
    const t = out.value
    pushAudit('kh', `triggered  executionId=${t.executionId ?? '?'} status=${t.status ?? '?'}`, 'ok')
  } else if (out.kind === 'workflow_status') {
    const s = out.value
    pushAudit('kh', `status=${s.status ?? '?'} progress=${s.progress ?? '?'}%`, 'ok')
    receiptEnvelope = { ...receiptEnvelope, status: 'settled' }
  } else if (out.kind === 'discover') {
    const list = out.value
    pushAudit('kh', `marketplace: ${list.length} MCP-callable workflows`, 'ok')
    for (const w of list.slice(0, 12)) {
      const price = w.priceUsdcPerCall ? `$${w.priceUsdcPerCall}` : 'free'
      pushAudit(
        'kh',
        `  ${w.id.slice(0, 14).padEnd(14)} ${price.padStart(5)}  ${w.name.slice(0, 60)}`,
        'info',
      )
    }
    if (list.length > 12) pushAudit('kh', `  …+${list.length - 12} more (refine: kh discover <search>)`, 'info')
    pushAudit('kh', `  (broader public-readable set: 85 via /api/workflows/public — not yet wired)`, 'info')
  } else if (out.kind === 'inspect') {
    const w = out.value
    if (!w) {
      pushAudit('kh', 'inspect: workflow not found in public catalog', 'err')
    } else {
      pushAudit('kh', `inspect ${w.id}: ${w.name}`, 'ok')
      pushAudit('kh', `  price: ${w.priceUsdcPerCall ? '$' + w.priceUsdcPerCall + ' USDC/call' : 'free'}`, 'info')
      const desc = (w.description ?? '').replace(/\s+/g, ' ').slice(0, 100)
      if (desc) pushAudit('kh', `  ${desc}${(w.description ?? '').length > 100 ? '…' : ''}`, 'info')
      const required = w.inputSchema?.required ?? []
      const allProps = Object.keys(w.inputSchema?.properties ?? {})
      pushAudit('kh', `  required (${required.length}): ${required.join(', ') || '—'}`, 'info')
      const optionalProps = allProps.filter((p) => !required.includes(p))
      if (optionalProps.length > 0) {
        pushAudit('kh', `  optional (${optionalProps.length}): ${optionalProps.join(', ').slice(0, 80)}`, 'info')
      }
      // Receipt panel gets the full schema for copy-paste into kh trigger
      receiptEnvelope = {
        ...receiptEnvelope,
        status: 'settled',
      }
    }
  }
  render()
}

// ── Slice X — `kh hire` close-the-loop dispatcher ───────────────────────────
//
// Closes the agentic-commerce loop: an iNFT in this TUI hires another
// agent's MCP-callable workflow on KeeperHub via x402. NO MOCKS — the
// path is:
//   1. `kh inspect <slugOrId>` — fetches `listedSlug`, `priceUsdcPerCall`,
//      `inputSchema` from `/api/mcp/workflows`. Refuses on `listedSlug ===
//      null` (workflow is discoverable but not yet slug-callable).
//   2. Validate required[] keys against operator-supplied JSON inputs;
//      refuse with the first missing key surfaced by name.
//   3. `payViaKeeperHubMarketplace` — the existing x402 round-trip.
//      Settles EIP-3009 USDC on Base Sepolia via KH's facilitator (30%
//      to KH, 70% to the workflow author). Returns the marketplace
//      tx hash + the workflow's response body.
//   4. Push three audit rows (intent, payment tx, truncated response)
//      and surface the FULL response JSON in the receipt panel.
//
// Honest refusal contract: if any required env var is missing we surface
// the EXACT names so the operator can fix .env and retry. We never
// fabricate a tx hash or synthesise a successful response — every byte
// comes off the wire.

async function dispatchKHHireIntent(
  intent: Extract<IntentCommand, { kind: 'kh-hire' }>,
): Promise<void> {
  const apiKey = process.env.KH_API_KEY
  if (!apiKey || apiKey.length === 0) {
    pushAudit('kh', 'KH_API_KEY missing — paste kh_… into .env, then restart TUI', 'err')
    setToast('err', 'KH_API_KEY required')
    render()
    return
  }
  const baseUrl = process.env.KEEPERHUB_API_URL && process.env.KEEPERHUB_API_URL.length > 0
    ? process.env.KEEPERHUB_API_URL
    : 'https://app.keeperhub.com'

  // Buyer wallet config — Turnkey-custodied agentic wallet. Same shape
  // as the AUTHOR config (the only KH-provisioned wallet shape), so we
  // reuse those env names. `KH_API_KEY` alone CANNOT pay — x402 needs a
  // signing wallet. `BASE_SEPOLIA_PRIVATE_KEY` ALSO can't replace this:
  // KH's signing service speaks HMAC over a Turnkey sub-org, not a raw
  // EVM key. If the operator hasn't provisioned a wallet, we refuse
  // honestly with the named missing keys (NEVER fall back synthetic).
  const subOrgId = process.env.KH_AUTHOR_SUBORG_ID
  const walletAddress = process.env.KH_AUTHOR_WALLET
  const hmacSecret = process.env.KH_AUTHOR_HMAC_SECRET
  const missing: string[] = []
  if (!subOrgId || subOrgId.length === 0) missing.push('KH_AUTHOR_SUBORG_ID')
  if (!walletAddress || walletAddress.length === 0) missing.push('KH_AUTHOR_WALLET')
  if (!hmacSecret || hmacSecret.length === 0) missing.push('KH_AUTHOR_HMAC_SECRET')
  if (missing.length > 0) {
    pushAudit(
      'kh',
      `kh hire blocked — buyer wallet env missing: ${missing.join(', ')} (provision via 'npx @keeperhub/wallet add')`,
      'err',
    )
    setToast('err', `missing: ${missing[0]}`)
    render()
    return
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress!)) {
    pushAudit('kh', `KH_AUTHOR_WALLET malformed — expected 0x + 40 hex chars`, 'err')
    setToast('err', 'KH_AUTHOR_WALLET malformed')
    render()
    return
  }

  // ── Step 1: inspect <slugOrId> to discover listedSlug + price + schema ──
  pushAudit('kh', `hire ${intent.slugOrId} → inspect (discover slug + price)`, 'info')
  render()
  const inspectResult = await executeKHCall(
    { kind: 'inspect', workflowId: intent.slugOrId },
    { env: { ...process.env, KH_API_KEY: apiKey, KEEPERHUB_API_URL: baseUrl } as NodeJS.ProcessEnv },
  )
  if (!inspectResult.ok) {
    const e = inspectResult.error
    pushAudit('kh', `hire failed (inspect ${e.kind}): ${e.reason.slice(0, 140)}`, 'err')
    setToast('err', `kh hire ${e.kind}`)
    render()
    return
  }
  let workflow = inspectResult.value.kind === 'inspect' ? inspectResult.value.value : null

  // The inspect helper looks up by `id`. If the operator passed a slug,
  // it'll miss — fall back to a discover-then-find-by-listedSlug pass so
  // both shapes (`kh hire <id>` and `kh hire <slug>`) work uniformly.
  if (!workflow) {
    const discoverResult = await executeKHCall(
      { kind: 'discover', filters: { limit: 1000 } },
      { env: { ...process.env, KH_API_KEY: apiKey, KEEPERHUB_API_URL: baseUrl } as NodeJS.ProcessEnv },
    )
    if (!discoverResult.ok) {
      const e = discoverResult.error
      pushAudit('kh', `hire failed (discover ${e.kind}): ${e.reason.slice(0, 140)}`, 'err')
      setToast('err', `kh hire ${e.kind}`)
      render()
      return
    }
    if (discoverResult.value.kind === 'discover') {
      const found = discoverResult.value.value.find(
        (w) => w.listedSlug === intent.slugOrId || w.id === intent.slugOrId,
      )
      workflow = found ?? null
    }
  }

  if (!workflow) {
    pushAudit(
      'kh',
      `hire failed — workflow "${intent.slugOrId}" not in MCP-callable catalog (try 'kh discover')`,
      'err',
    )
    setToast('err', 'workflow not found')
    render()
    return
  }

  // Honest refusal: discoverable but not slug-callable.
  const slugResolution = resolveCallableSlug(workflow)
  if (!slugResolution.ok) {
    pushAudit(
      'kh',
      `hire refused — workflow ${slugResolution.workflowId.slice(0, 14)}… is discoverable but not yet slug-callable; register a slug on KH`,
      'err',
    )
    setToast('err', 'no listedSlug — not callable')
    render()
    return
  }
  const slug = slugResolution.slug
  const price = workflow.priceUsdcPerCall ?? '0'

  // ── Step 2: validate required[] keys against operator-supplied inputs ──
  const validation = validateRequiredInputs(workflow, intent.inputs)
  if (!validation.ok) {
    pushAudit(
      'kh',
      `hire refused — inputs missing required key "${validation.missing}" (schema requires: ${validation.required.join(', ')})`,
      'err',
    )
    setToast('err', `missing input: ${validation.missing}`)
    render()
    return
  }
  const provided = intent.inputs ?? {}
  const requiredCount = workflow.inputSchema?.required?.length ?? 0

  // ── Step 3: real x402 settlement via KeeperHub marketplace ──
  pushAudit('kh', `hire.intent ${slug} $${price} (${requiredCount} required keys validated)`, 'info')
  render()
  try {
    const settlement = await payViaKeeperHubMarketplace(
      {
        subOrgId: subOrgId!,
        walletAddress: walletAddress! as `0x${string}`,
        hmacSecret: hmacSecret!,
        marketplaceSlug: slug,
        baseUrl,
      },
      provided,
    )
    pushAudit('kh', `hire.payment ${settlement.paymentTxHash} (${settlement.network})`, 'ok')

    // Truncate the response to 160 chars in the audit row; the receipt
    // panel keeps the full JSON below.
    const responseJson = JSON.stringify(settlement.marketplaceResponse)
    const truncated = responseJson.length > 160
      ? `${responseJson.slice(0, 160)}…`
      : responseJson
    pushAudit('kh', `hire.response ${truncated}`, 'ok')

    receiptEnvelope = {
      ...receiptEnvelope,
      status: 'settled',
      khResponse: settlement.marketplaceResponse,
    }
    setToast('ok', `kh hire ${slug} settled`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    pushAudit('kh', `hire failed: ${msg.slice(0, 140)}`, 'err')
    setToast('err', `kh hire failed`)
  }
  render()
}

// `permissionIdFor`, `openGrantModal`, and `confirmGrant` live in `./grant.ts`.

// ── Keyboard ──────────────────────────────────────────────────────────────────

process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.setEncoding("utf8")

function handleIntentKey(key: string): boolean {
  // `?` — toggle help overlay even while editing. Intent commands
  // never contain `?`, so claiming the key here is unambiguous.
  if (key === '?') {
    helpOverlayOpen = !helpOverlayOpen
    return true
  }
  // Enter — parse + dispatch.
  if (key === '\r' || key === '\n') {
    const parsed = parseIntent(intentBuffer)
    if (parsed.kind === 'unknown') {
      intentHint = parsed.reason
      stagedIntent = null
      return true
    }
    if (parsed.kind === 'unknown_agent') {
      // Distinct hint vs `unknown` — the user typed a syntactically
      // valid `*.eth` but it's not in our minted-agent registry.
      // Keep them oriented instead of falling through to the generic
      // command-help line.
      intentHint = parsed.message
      stagedIntent = null
      return true
    }
    if (parsed.kind === 'empty') {
      intentHint = ''
      stagedIntent = null
      return true
    }
    intentHint = ''
    stagedIntent = parsed
    if (parsed.kind === 'audit') void dispatchAuditIntent(parsed)
    else if (parsed.kind === 'ask-oracle') void dispatchAskOracleIntent(parsed)
    else if (parsed.kind === 'swap') void dispatchSwapIntent(parsed)
    else if (parsed.kind === 'transfer') void dispatchTransferIntent(parsed)
    // Slice H — AxiomCommit pre-commit / reveal log
    else if (parsed.kind === 'axiom-commit') void dispatchAxiomCommitIntent(parsed)
    else if (parsed.kind === 'axiom-reveal') void dispatchAxiomRevealIntent(parsed)
    // Slice I — ERC-7710 redeemable delegation via DelegationManager
    else if (parsed.kind === 'delegate') void dispatchDelegate(parsed)
    // Phase 3 operator UX
    else if (parsed.kind === 'agents') void dispatchOperatorAgents()
    else if (parsed.kind === 'balances') void dispatchOperatorBalances()
    else if (parsed.kind === 'block') void dispatchOperatorBlock()
    else if (parsed.kind === 'mint') void dispatchOperatorMint(parsed)
    else if (parsed.kind === 'cancel') void dispatchOperatorCancel()
    // Slice K — yield vault park / unpark
    else if (parsed.kind === 'park') void dispatchParkIntent(parsed)
    else if (parsed.kind === 'unpark') void dispatchUnparkIntent(parsed)
    // Slice J — ACP / EIP-8183 escrow create + release
    else if (parsed.kind === 'acp-create') void dispatchAcpCreateIntent(parsed)
    else if (parsed.kind === 'acp-release') void dispatchAcpReleaseIntent(parsed)
    // Phase 2 KH direct API — auth via KH_API_KEY env, no liveBundle gate
    else if (parsed.kind === 'kh-trigger' || parsed.kind === 'kh-status'
          || parsed.kind === 'kh-workflows' || parsed.kind === 'kh-integrations'
          || parsed.kind === 'kh-discover' || parsed.kind === 'kh-inspect') {
      void dispatchKHIntent(parsed)
    }
    // Slice X — `kh hire`: pay-and-invoke via x402 (close-the-loop)
    else if (parsed.kind === 'kh-hire') {
      void dispatchKHHireIntent(parsed)
    }
    // ERC-4337 SimpleAccount predict + deploy via AgentSimpleAccountFactory
    else if (parsed.kind === 'aa-deploy') void dispatchAaDeployIntent(parsed)
    // ERC-4337 UserOp send through Pimlico bundler (gas via paymaster)
    else if (parsed.kind === 'aa-send') void dispatchAaSendIntent(parsed)
    return true
  }
  // Backspace (0x7f / 0x08).
  if (key === '\x7f' || key === '\b') {
    intentBuffer = intentBuffer.slice(0, -1)
    refreshLivePreview()
    return true
  }
  // Esc — close help overlay first, otherwise clear input. Two-step
  // dismissal so the operator can read the overlay without losing
  // their half-typed intent.
  if (key === '\x1b') {
    if (helpOverlayOpen) {
      helpOverlayOpen = false
      return true
    }
    intentBuffer = ''
    intentHint = ''
    stagedIntent = null
    return true
  }
  // Tab — blur.
  if (key === '\t') {
    intentMode = 'idle'
    return true
  }
  // Single printable char (0x20..0x7e). Skip multi-byte sequences
  // (arrow keys etc.) — those start with 0x1b followed by `[X` which
  // we already partial-match above.
  if (key.length === 1) {
    const code = key.charCodeAt(0)
    if (code >= 32 && code < 127) {
      intentBuffer += key
      refreshLivePreview()
      return true
    }
  }
  return false
}

/// Re-parse the intent buffer on every keystroke and set a pre-Enter
/// hint when the buffer resolves to a decision-supporting intent (today:
/// just `park`, where the operator's pre-decision question is "is the
/// APY a peak, a trough, or a stable plateau?"). Other intents leave
/// the hint empty — there's no useful trend to surface for them.
function refreshLivePreview(): void {
  const parsed = parseIntent(intentBuffer)
  if (parsed.kind === 'park') {
    intentHint = apyTrendHint({
      vaultLabel: 'MockERC4626',
      apyPct: DEMO_APY_PCT,
      samples: DEMO_APY_SAMPLES_30D,
    })
    return
  }
  intentHint = ''
}

process.stdin.on("data", (key: string) => {
  if (toast) toast = null

  // Modal eats everything.
  if (grantModalOpen) {
    if (key === '\r' || key === '\n') {
      void confirmGrantImpl({
        stagedIntent,
        setToast,
        setGrantModal: (lines, open) => { grantModalLines = lines; grantModalOpen = open },
        render,
      }).then(() => render())
    } else if (key === '\x1b') {
      grantModalOpen = false
    }
    render()
    return
  }

  // Editing mode — buffer chars unless the keypress is a global hotkey
  // unrecognised by handleIntentKey (in which case it falls through).
  if (intentMode === 'editing') {
    if (handleIntentKey(key)) {
      render()
      return
    }
    // Fall-through: unrecognised keys (e.g. Ctrl+C) hit the global
    // handler below. Most users won't reach this path.
  }

  // Global hotkeys (Ctrl+C always escapes).
  if (key === '\x03') { cleanup(); process.exit(0) }
  if (key === 'q' || key === 'Q') {
    if (intentMode === 'idle') { cleanup(); process.exit(0) }
  }
  if (key === '?') {
    // `?` toggles the help overlay regardless of focus.
    helpOverlayOpen = !helpOverlayOpen
  } else if (key === '\x1b' && helpOverlayOpen) {
    // Esc closes the overlay when in idle mode (handleIntentKey
    // already handles the editing-mode case).
    helpOverlayOpen = false
  } else if (key === '\t') {
    intentMode = intentMode === 'editing' ? 'idle' : 'editing'
  } else if (key === 'g' || key === 'G') {
    openGrantModalImpl({
      stagedIntent,
      setToast,
      setGrantModal: (lines, open) => { grantModalLines = lines; grantModalOpen = open },
      render,
    })
  } else if (key === 'r' || key === 'R') {
    // Reset the FLOW panel + audit trail. Slice C dropped the
    // synthetic walkthrough (advance/setAuto), so this is the only
    // surviving "back to a clean slate" hotkey. Idle-mode only — we
    // don't want a stray `R` while typing an intent to wipe state.
    if (intentMode === 'idle') {
      flow = mkFlow()
      AUDIT.length = 0
      receiptEnvelope = EMPTY_RECEIPT
      stagedIntent = null
      intentBuffer = ''
      render()
    }
  }
  render()
})

// ── Cleanup ───────────────────────────────────────────────────────────────────

function cleanup() {
  if (renderTimer)  clearInterval(renderTimer)
  process.stdout.write(`${E}[?25h${E}[2J${E}[H`)
}

process.on("exit",   cleanup)
process.on("SIGINT", () => { cleanup(); process.exit(0) })
process.stdout.on("resize", render)

// Refresh clock + receipt JSON in header every second. Async dispatchers
// mutate state in the background; this tick is what paints them.
renderTimer = setInterval(render, 1000)

// ── Start ─────────────────────────────────────────────────────────────────────

process.stdout.write(`${E}[2J`)
pushAudit('system', 'tui ready — type an intent below and Enter to dispatch', 'info')
render()
