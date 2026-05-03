// ── Orchestrator step → FLOW state mapper ────────────────────────────────────
//
// Slice C: the FLOW panel's only driver. Each `runCrossAgentDemo`
// transcript step is mapped to:
//   - one or more `pushAudit` rows (the AUDIT TRAIL),
//   - mutations on the shared `FlowState` (which node is active, which
//     rail settled, whether the run is complete),
//   - and (for settle / receipt-post) an async fetch of the on-chain
//     event payload that updates the `receiptEnvelope` envelope.
//
// State mutation is funnelled through callbacks (`getFlow`, `setFlow`,
// `setReceiptEnvelope`) so the dispatcher in `index.ts` keeps owning the
// run-time state — this module is just the rule book.

import type { Hex } from 'viem';
import type { TranscriptStep } from '../../demo/src/cross-agent.js';
import type { FlowState } from './flow-state.js';
import type { ReceiptEnvelope } from './receipt-feed.js';
import { pushAudit } from './audit-trail.js';
import { basescanTxUrl, chainscanTxUrl, storagescanSubmissionUrl } from '../../demo/src/explorer-urls.js';
import { shortHash } from './format.js';
import { tryBuildLiveBundle } from './live-bundle.js';

export const KNOWN_STEPS: readonly string[] = [
  'oracle.spend_cap.check', 'oracle.spend_cap.exceeded',
  'oracle.payment.request', 'oracle.payment.settle',
  'oracle.query.start', 'oracle.query.complete',
  'audit.capabilities.read', 'audit.axiom.commit', 'audit.axiom.reveal',
  'audit.memory_root.pin', 'audit.start', 'audit.complete', 'audit.failed',
  'audit.report.pin', 'audit.report.unpinned',
  'audit.receipt.post', 'audit.receipt.failed',
];

export interface OrchestratorStepEnv {
  /// Read the current FlowState. Mutated in-place by this module —
  /// caller passes a reference, we set node/rail fields directly.
  flow: FlowState;
  /// Reassign the receipt envelope (used by the async on-chain fetches).
  setReceiptEnvelope: (e: ReceiptEnvelope) => void;
  /// Read the most recent envelope (used to spread into a new copy when
  /// `Split` / `NewFeedback` decoding lands).
  getReceiptEnvelope: () => ReceiptEnvelope;
  /// Surface a toast (e.g. cap_not_found unblock hint).
  setToast: (kind: 'ok' | 'err' | 'info', text: string) => void;
}

export function applyOrchestratorStep(env: OrchestratorStepEnv, step: TranscriptStep): void {
  const { flow, setReceiptEnvelope, getReceiptEnvelope, setToast } = env;
  const detail = step.detail ?? {};
  switch (step.name) {
    case 'oracle.payment.request':
      // INTENT active. First emission per run — reset all downstream
      // node + rail state so a fresh dispatch doesn't inherit prior run.
      pushAudit('orchestrator', `payment request: ${detail.amount ?? '—'} atomic`, 'info');
      flow.nodes = ['active', 'off', 'off', 'off'];
      flow.rails = { x402: 'off', direct_split: 'off' };
      flow.settledRail = null;
      flow.complete = false;
      break;
    case 'oracle.spend_cap.check':
      pushAudit('spend-cap', `cap pre-flight ok (enforced=${detail.enforced ?? false} remaining=${detail.remaining ?? '—'})`, 'ok');
      flow.nodes = ['done', 'active', 'off', 'off'];
      break;
    case 'oracle.spend_cap.exceeded': {
      // POLICY rejected — whole flow halts. Cascade `rejected` to the
      // downstream nodes so the operator sees the deliberate stop
      // rather than "off" (which would imply "not yet evaluated").
      const reason = String(detail.reason ?? 'exceeded');
      pushAudit('spend-cap', `BLOCKED: ${reason}`, 'err');
      // cap_not_found is the most common first-run reason — surface a
      // contextual fix instead of leaving the operator wondering. Also
      // a generic hint for any other cap rejection.
      if (reason === 'cap_not_found') {
        pushAudit(
          'spend-cap',
          'unblock: press [G] to grant 0.5 USDC SpendCap permission, then re-dispatch the audit',
          'info',
        );
        setToast('info', 'press [G] to grant SpendCap then retry');
      } else {
        pushAudit(
          'spend-cap',
          `unblock: press [G] to grant a higher cap or refresh the period; then re-dispatch`,
          'info',
        );
      }
      flow.nodes = ['done', 'rejected', 'rejected', 'rejected'];
      flow.complete = true;
      break;
    }
    case 'oracle.payment.settle': {
      const txHash = typeof detail.txHash === 'string' ? (detail.txHash as Hex) : null;
      const rail = typeof detail.rail === 'string' ? detail.rail : '?';
      pushAudit('orchestrator', `settle rail=${rail} tx=${txHash ? shortHash(txHash) : '—'}`, 'ok');
      // RAILS active (policy done). EXECUTE doesn't fire until
      // `audit.start` — the settle leg only chose the rail; the
      // ERC-8004 receipt write is a downstream step.
      flow.nodes = ['done', 'done', 'active', 'off'];
      // Reflect the truthful rail in the FLOW panel: only light up the
      // rail that the orchestrator actually used. Slice C narrowed the
      // rail set to {x402, direct_split} — those are the only values
      // `SettleOutput.rail` ever carries, so any other string falls
      // through to "no rail lit" rather than fabricating a third option.
      if (rail === 'x402') {
        flow.rails = { x402: 'done', direct_split: 'rejected' };
        flow.settledRail = 'x402';
      } else if (rail === 'direct_split') {
        flow.rails = { x402: 'rejected', direct_split: 'done' };
        flow.settledRail = 'direct_split';
      } else {
        flow.rails = { x402: 'rejected', direct_split: 'rejected' };
        flow.settledRail = null;
      }
      const liveBundleCached = tryBuildLiveBundle();
      if (txHash) {
        pushAudit('receipt', `Base Sepolia: ${basescanTxUrl(txHash)}`, 'ok');
      }
      const isZeroHash = !txHash || /^0x0+$/.test(txHash);
      if (!isZeroHash && liveBundleCached) {
        liveBundleCached.receiptFeed
          .fetchSplit(txHash!)
          .then((split) => {
            if (split) {
              setReceiptEnvelope({ ...getReceiptEnvelope(), status: 'settled', split });
              pushAudit('receipt', `Split decoded blk=${split.blockNumber} owner=${split.ownerCut} kh=${split.keeperCut}`, 'ok');
            }
          })
          .catch((e) => {
            pushAudit('receipt', `Split fetch failed: ${e instanceof Error ? e.message : String(e)}`, 'err');
          });
      }
      break;
    }
    case 'oracle.query.start':
      pushAudit('oracle', `query start topic=${detail.topic ?? '?'}`, 'info');
      break;
    case 'oracle.query.complete':
      pushAudit('oracle', `query complete ok=${detail.ok ?? '?'}`, detail.ok === true ? 'ok' : 'err');
      break;
    case 'audit.capabilities.read':
      pushAudit('audit-agent', `capabilities read manifestLen=${detail.manifestLen ?? 0}`, detail.ok === false ? 'err' : 'info');
      break;
    case 'audit.axiom.commit': {
      const cid = detail.commitId ? String(detail.commitId) : null;
      const tx  = detail.txHash   ? String(detail.txHash)   : null;
      if (detail.ok === false) {
        const reason = detail.error ? String(detail.error) : 'unknown';
        pushAudit('axiom', `commit failed: ${reason}`, 'err');
      } else {
        pushAudit('axiom', `commit ok commitId=${cid ? shortHash(cid) : '—'} tx=${tx ? shortHash(tx) : '—'}`, 'ok');
        if (tx) pushAudit('axiom', `0G: ${chainscanTxUrl(tx)}`, 'info');
      }
      break;
    }
    case 'audit.start':
      pushAudit('audit-agent', `start agentId=${detail.agentId ?? '?'}`, 'info');
      flow.nodes = ['done', 'done', 'done', 'active'];
      break;
    case 'audit.complete':
      pushAudit('audit-agent', `complete verdict=${detail.verdict ?? '?'} findings=${detail.findingsCount ?? 0}`, 'ok');
      flow.nodes = ['done', 'done', 'done', 'done'];
      flow.complete = true;
      break;
    case 'audit.failed':
      // EXECUTE rejected.
      pushAudit('audit-agent', `FAILED: ${detail.reason ?? 'unknown'}`, 'err');
      flow.nodes = ['done', 'done', 'done', 'rejected'];
      flow.complete = true;
      break;
    case 'audit.receipt.post': {
      // EXECUTE done — receipt posting is a terminal success signal.
      // We honour whichever fires first (`audit.complete` or this);
      // both stamp the EXECUTE node green.
      const txHash = typeof detail.txHash === 'string' ? (detail.txHash as Hex) : null;
      pushAudit('erc-8004', `receipt posted tx=${txHash ? shortHash(txHash) : '—'}`, 'ok');
      if (txHash) pushAudit('erc-8004', `0G: ${chainscanTxUrl(txHash)}`, 'info');
      flow.nodes = ['done', 'done', 'done', 'done'];
      flow.complete = true;
      const liveBundleCached = tryBuildLiveBundle();
      const isZeroFeedbackHash = !txHash || /^0x0+$/.test(txHash);
      if (!isZeroFeedbackHash && liveBundleCached) {
        // 0G Galileo takes ~15s to mine — delay before polling so we don't
        // flood with "not found" errors on a tx that's still in the mempool.
        setTimeout(() => {
          liveBundleCached!.receiptFeed
            .fetchNewFeedback(txHash!)
            .then((nf) => {
              if (nf) {
                setReceiptEnvelope({ ...getReceiptEnvelope(), status: 'settled+receipt', newFeedback: nf });
                pushAudit('receipt', `NewFeedback decoded idx=${nf.feedbackIndex}`, 'ok');
              }
            })
            .catch((e) => {
              pushAudit('receipt', `NewFeedback fetch failed: ${e instanceof Error ? e.message : String(e)}`, 'err');
            });
        }, 15_000);
      }
      break;
    }
    case 'audit.receipt.failed':
      // EXECUTE rejected — only downgrade if EXECUTE hasn't already
      // reached the `done` terminal (avoids overriding an earlier
      // `audit.complete` that succeeded before the on-chain write).
      pushAudit('erc-8004', `receipt FAILED: ${detail.reason ?? 'unknown'}`, 'err');
      if (flow.nodes[3] !== 'done') {
        flow.nodes = ['done', 'done', 'done', 'rejected'];
        flow.complete = true;
      }
      break;
    case 'audit.memory_root.pin': {
      const tx = typeof detail.txHash === 'string' ? detail.txHash : null;
      pushAudit('memory', `pin ok=${detail.ok ?? '?'} root=${detail.rootHash ? shortHash(String(detail.rootHash)) : '—'}`, detail.ok === true ? 'ok' : 'err');
      if (tx) pushAudit('memory', `0G: ${chainscanTxUrl(tx)}`, 'info');
      break;
    }
    case 'audit.axiom.reveal': {
      const tx = typeof detail.txHash === 'string' ? detail.txHash : null;
      pushAudit('axiom', `reveal ok=${detail.ok ?? '?'}`, detail.ok === true ? 'ok' : 'err');
      if (tx) pushAudit('axiom', `0G: ${chainscanTxUrl(tx)}`, 'info');
      break;
    }
    case 'audit.report.pin': {
      // 0G Storage anchor — the regulator-readable proof that the canonical
      // AuditReport bytes exist at this rootHash. Re-fetch + re-hash to
      // verify against the on-chain feedbackHash.
      const uri = typeof detail.uri === 'string' ? detail.uri : null;
      const hash = typeof detail.hash === 'string' ? detail.hash : null;
      const txSeq = typeof detail.txSeq === 'number' ? detail.txSeq : null;
      pushAudit('storage', `pinned uri=${uri ? shortHash(uri) : '—'} hash=${hash ? shortHash(hash) : '—'}`, 'ok');
      // Storagescan indexes by txSeq (`/submission/<txSeq>`), NOT by
      // rootHash. We emit the URL only when txSeq is available; mock
      // paths skip it rather than print a misleading link.
      if (txSeq !== null) pushAudit('storage', `0G Storage: ${storagescanSubmissionUrl(txSeq)}`, 'info');
      break;
    }
    case 'audit.report.unpinned':
      pushAudit('storage', `unpinned reason=${detail.reason ?? detail.kind ?? 'unknown'}`, 'err');
      break;
    default:
      pushAudit('orchestrator', step.name, 'info');
  }
}
