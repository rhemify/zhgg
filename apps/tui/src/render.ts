// ── Frame builder ────────────────────────────────────────────────────────────
//
// Pure(ish) frame-builder: takes a snapshot of the current TUI state,
// returns the full ANSI frame string. The caller (render loop in
// `index.ts`) writes the result to stdout in a single `process.stdout.write`
// call to avoid flicker. State is passed in as a struct rather than
// accessed as module locals — keeps this file independent of the
// dispatcher's mutable globals.

import type { Hex } from 'viem';
import type { ReceiptEnvelope } from './receipt-feed.js';
import { envelopeJson } from './receipt-feed.js';
import { $, at } from './theme.js';
import {
  W, H, MID,
  ROW_HEADER_TOP, ROW_HEADER_BOT, ROW_TOP_START, ROW_TOP_END,
  ROW_MID_DIV, ROW_BOT_START,
  ROW_LOG, ROW_RECEIPT, ROW_HINT, ROW_INTENT, ROW_STATUS, ROW_FOOTER,
  FLOW_COL, FLOW_NODE_W, nodeRow,
} from './layout.js';
import { pad, shortHash, formatStaged } from './format.js';
import { AUDIT } from './audit-trail.js';
import type { FlowState, NS } from './flow-state.js';
import { liveAgents, agentStatus, type RunningCommand } from './agent-status.js';
import { tryBuildLiveBundle, getLiveBundleError } from './live-bundle.js';
import { buildHelpLines, PERSISTENT_HINT, type HelpLine } from './help-overlay.js';
import type { IntentCommand } from './intent-parser.js';

function nodeStyle(ns: NS): string {
  if (ns === 'active')   return $.bold + $.green + $.bgNode;
  if (ns === 'done')     return $.bold + $.green;   // stays bright — judges see every step
  if (ns === 'rejected') return $.bold + $.red + $.bgRej;
  return $.gray;
}

function nodeBorder(ns: NS) {
  if (ns === 'active') return { tl:'╔',tr:'╗',bl:'╚',br:'╝',h:'═',v:'║' };
  if (ns === 'done')   return { tl:'╔',tr:'╗',bl:'╚',br:'╝',h:'═',v:'║' }; // double border stays
  return { tl:'┌',tr:'┐',bl:'└',br:'┘',h:'─',v:'│' };
}

export type PanelOverlay = 'none' | 'audit' | 'flow';

export interface FrameState {
  flow: FlowState;
  stagedIntent: IntentCommand | null;
  runningCommand: RunningCommand;
  receiptEnvelope: ReceiptEnvelope;
  intentBuffer: string;
  intentMode: 'idle' | 'editing';
  intentHint: string;
  toast: { kind: 'ok' | 'err' | 'info'; text: string } | null;
  grantModalOpen: boolean;
  grantModalLines: string[];
  helpOverlayOpen: boolean;
  panelOverlay: PanelOverlay;
}

// Build entire frame as a string (prevents flicker vs multiple writes)
export function buildFrame(state: FrameState): string {
  const {
    flow, stagedIntent, runningCommand, receiptEnvelope,
    intentBuffer, intentMode, intentHint, toast,
    grantModalOpen, grantModalLines, helpOverlayOpen, panelOverlay,
  } = state;
  const w = W(), h = H(), mid = MID();
  let f = '';

  const put = (r: number, c: number, s: string): void => { f += at(r, c) + s; };

  // ── Header ────────────────────────────────────────────────────────────────
  put(ROW_HEADER_TOP, 1, $.bold + $.cyan + '╔' + '═'.repeat(w - 2) + '╗' + $.reset);

  // header content row — MODE pill reflects ground truth, no aspirational
  // labels. Three states:
  //   live          → all env present, ZG_ROUTER_KEY set (real Qwen possible)
  //   inference-blk → env present but ZG_ROUTER_KEY empty (audit refused;
  //                   settle/grant still work)
  //   env-incomplete→ readLiveConfigFromEnv threw; first missing key shown
  const now      = new Date().toLocaleTimeString('en-GB');
  const bundle   = tryBuildLiveBundle();
  const modeText = bundle
    ? (bundle.inferenceReady ? 'MODE:live' : 'MODE:inference-blocked')
    : `MODE:env-incomplete (${(getLiveBundleError() ?? '?').slice(0, 40)})`;
  const modeColor = bundle && bundle.inferenceReady
    ? $.green
    : bundle
      ? $.yellow
      : $.red;
  const hLeft  = '  zhgg runtime';
  const hRight = `${modeText}  │  ${now}  `;
  const hPad   = ' '.repeat(Math.max(0, w - hLeft.length - hRight.length - 2));
  put(2, 1, $.bold + $.cyan + '║' + $.reset);
  put(2, 2, $.bold + $.white + hLeft + $.reset + $.dwhite + hPad + $.reset + modeColor + modeText + $.reset + $.dwhite + `  │  ${now}  ` + $.reset);
  put(2, w, $.bold + $.cyan + '║' + $.reset);

  put(ROW_HEADER_BOT, 1, $.bold + $.cyan + '╠' + '═'.repeat(mid - 1) + '╦' + '═'.repeat(w - mid - 2) + '╣' + $.reset);

  // ── Top section titles ────────────────────────────────────────────────────
  const topEnd = ROW_TOP_END();
  put(ROW_TOP_START, 1, $.bold + $.cyan + '║' + $.reset);
  put(ROW_TOP_START, 2, $.bold + $.cyan + '  ◈ ' + $.reset + $.bold + $.white + 'iNFT AGENTS' + $.reset + $.dwhite + '  (role in current workflow →)' + $.reset);
  put(ROW_TOP_START, mid + 1, $.bold + $.cyan + '║' + $.reset);
  put(ROW_TOP_START, mid + 2, $.bold + $.cyan + '  ◈ ' + $.reset + $.bold + $.white + 'ACTION QUEUE' + $.reset);
  put(ROW_TOP_START, w, $.bold + $.cyan + '║' + $.reset);

  // Agent rows — driven by agent-registry.ts (real iNFTs minted on 0G)
  // and current dispatch state. No hardcoded statuses.
  const agents = liveAgents();
  agents.forEach((a, i) => {
    const r  = ROW_TOP_START + 1 + i;
    const st = agentStatus(a, stagedIntent, runningCommand);
    if (r <= topEnd) {
      put(r, 1, $.cyan + '║' + $.reset);
      put(
        r, 3,
        st.color + st.glyph + ' ' + pad(a.name, 14) + ' ' + $.dwhite + pad('#' + a.tokenId.toString(), 3) + ' ' +
        $.dwhite + pad(a.scope, 36) + ' ' + st.color + st.label + $.reset,
      );
      put(r, mid + 1, $.cyan + '║' + $.reset);
      put(r, w, $.cyan + '║' + $.reset);
    }
  });

  // Action queue — only renders when an intent is staged (typed but not
  // yet dispatched) or running. Empty otherwise; never invents a queue.
  if (stagedIntent || runningCommand !== 'idle') {
    const r1 = ROW_TOP_START + 1;
    const r2 = r1 + 1;
    const headline =
      runningCommand === 'audit' ? `audit-agent → running on token ${stagedIntent?.kind === 'audit' ? '#' + stagedIntent.tokenId.toString() : '?'}` :
      runningCommand === 'ask-oracle' ? 'oracle-agent → query in flight' :
      runningCommand === 'swap' ? 'swap-agent → swap in flight' :
      runningCommand === 'transfer' ? 'transfer-agent → tx in flight' :
      stagedIntent?.kind === 'audit' ? `audit-agent → audit token #${stagedIntent.tokenId}` :
      stagedIntent?.kind === 'ask-oracle' ? `oracle-agent → ${stagedIntent.topic}` :
      stagedIntent?.kind === 'swap' ? `swap-agent → ${stagedIntent.amount} ${stagedIntent.fromSym}→${stagedIntent.toSym}` :
      'idle';
    const detail = runningCommand !== 'idle'
      ? `      status=running   (await results in AUDIT TRAIL)`
      : `      status=staged    [Enter] dispatch   [G] grant   [Esc] clear`;
    if (r1 <= topEnd) {
      put(r1, mid + 2, $.white + '  ▸ ' + headline + $.reset);
      put(r1, w, $.cyan + '║' + $.reset);
    }
    if (r2 <= topEnd) {
      const col = runningCommand !== 'idle' ? $.green : $.yellow;
      put(r2, mid + 2, col + detail + $.reset);
      put(r2, w, $.cyan + '║' + $.reset);
    }
  } else {
    const r1 = ROW_TOP_START + 1;
    if (r1 <= topEnd) {
      put(r1, mid + 2, $.dwhite + '  (queue empty — type an intent below)' + $.reset);
      put(r1, w, $.cyan + '║' + $.reset);
    }
  }

  // Borders & side bars for top section rows
  for (let r = ROW_TOP_START + 1; r <= topEnd; r++) {
    put(r, 1, $.cyan + '║' + $.reset);
    put(r, mid + 1, $.gray + '│' + $.reset);
    put(r, w, $.cyan + '║' + $.reset);
  }

  // ── Mid divider ───────────────────────────────────────────────────────────
  const midDiv = ROW_MID_DIV();
  put(midDiv, 1, $.cyan + '╠' + '─'.repeat(mid - 1) + '╪' + '─'.repeat(w - mid - 2) + '╣' + $.reset);

  // ── Bottom section titles ─────────────────────────────────────────────────
  const botStart = ROW_BOT_START();
  put(botStart, 1, $.cyan + '║' + $.reset);
  put(botStart, 2, $.bold + $.cyan + '  ◈ ' + $.reset + $.bold + $.white + 'AUDIT TRAIL' + $.reset
    + $.gray + '  [Z] expand' + $.reset);
  put(botStart, mid + 1, $.cyan + '║' + $.reset);
  put(botStart, mid + 2, $.bold + $.cyan + '  ◈ ' + $.reset + $.bold + $.white + 'PAYMENT FLOW + RECEIPT' + $.reset
    + $.gray + '  [X] expand' + $.reset);
  // RAIL pill — visible badge in the FLOW panel header showing the actual
  // settled rail (truthful: only set after `oracle.payment.settle` lands).
  // Lives just to the right of the panel title so judges can see at a
  // glance whether x402 or direct_split actually settled this run.
  const railPillText = flow.settledRail === 'x402'
    ? ' RAIL: x402 '
    : flow.settledRail === 'direct_split'
      ? ' RAIL: direct_split '
      : ' RAIL: — ';
  const railPillColor = flow.settledRail === null
    ? $.gray
    : $.bold + $.green + $.bgNode;
  put(botStart, mid + 28, railPillColor + railPillText + $.reset);
  // Controls hint (right-aligned in header). SPACE/A removed since the
  // mock walk-through was deleted in Slice C.
  const hint = ' ?·R·G·TAB·Q ';
  put(botStart, w - hint.length, $.gray + hint + $.reset);
  put(botStart, w, $.cyan + '║' + $.reset);

  // Audit trail (live AUDIT array, sticky-bottom).
  const logEnd = ROW_LOG() - 1;
  const auditCapacity = Math.max(0, logEnd - botStart);
  const visible = AUDIT.slice(-auditCapacity);
  const nowMs = Date.now();
  visible.forEach((e, i) => {
    const r = botStart + 1 + i;
    if (r > logEnd) return;
    const flash = nowMs < e.flashUntil;
    // Sidebar glyph: flashing rows get a bright accent bar instead of '║'
    const sideGlyph = flash
      ? (e.ok === 'ok' ? $.bold + $.green : e.ok === 'err' ? $.bold + $.red : $.bold + $.cyan) + '▐' + $.reset
      : $.cyan + '║' + $.reset;
    put(r, 1, sideGlyph);
    // Text: flashing rows pop in bold+bright with a leading trade-tick glyph
    const ec = flash
      ? (e.ok === 'ok' ? $.bold + $.green : e.ok === 'err' ? $.bold + $.red : $.bold + $.cyan)
      : (e.ok === 'ok' ? $.dgreen : e.ok === 'err' ? $.dred : $.dwhite);
    const prefix = flash ? (e.ok === 'ok' ? '▶ ' : e.ok === 'err' ? '✕ ' : '◈ ') : '  ';
    const line = e.time + ' ' + pad(e.agent, 10) + ' ' + prefix + e.event;
    put(r, 3, ec + line.slice(0, mid - 4) + $.reset);
  });
  // Empty hint when no events yet
  if (AUDIT.length === 0 && botStart + 1 <= logEnd) {
    put(botStart + 1, 3, $.dwhite + '(no events — type an intent below and Enter to dispatch)' + $.reset);
  }

  // Side bars for bottom section
  for (let r = botStart + 1; r <= logEnd; r++) {
    put(r, 1, $.cyan + '║' + $.reset);
    put(r, mid + 1, $.gray + '│' + $.reset);
    put(r, w, $.cyan + '║' + $.reset);
  }

  // ── Payment flow node diagram ─────────────────────────────────────────────
  const fc   = FLOW_COL();
  const nw   = FLOW_NODE_W;
  const labels  = ['INTENT', 'POLICY', 'RAILS', 'EXECUTE'];

  flow.nodes.forEach((ns, i) => {
    const nr   = nodeRow(i);
    const b    = nodeBorder(ns);
    const col  = nodeStyle(ns);
    const inner = nw - 2;

    // Top border
    if (nr <= logEnd)
      put(nr, fc, col + b.tl + b.h.repeat(inner) + b.tr + $.reset);

    // Label row
    if (nr + 1 <= logEnd) {
      const label = pad(' ' + labels[i]!, inner);
      put(nr + 1, fc, col + b.v + $.reset + col + label + $.reset + col + b.v + $.reset);
    }

    // Bottom border
    if (nr + 2 <= logEnd)
      put(nr + 2, fc, col + b.bl + b.h.repeat(inner) + b.br + $.reset);

    // Wire below (except last node)
    if (i < 3) {
      const wr = nr + 3;
      if (wr <= logEnd) {
        const wireLit = ns === 'done';
        const wc = wireLit ? $.bold + $.green : $.dgray;
        const wireGlyph = wireLit ? '▼' : '│';
        put(wr, fc + Math.floor(nw / 2) - 1, wc + wireGlyph + $.reset);
      }
    }

    // Rail labels beside RAILS node (index 2). Only the two rails we
    // actually emit on `oracle.payment.settle` are shown — exactly one
    // can be `done` per run, the other is `rejected` (truthful UI: the
    // non-selected rail wasn't tried, but the visual contract is "lit
    // = chosen, dim red = not chosen", which is accurate).
    if (i === 2) {
      const railCol = fc + nw + 2;
      const rr = flow.rails;
      const railLines: Array<{ label: string; ns: NS; tag: string }> = [
        { label: 'x402        ', ns: rr.x402,        tag: rr.x402 === 'done' ? ' ◀' : '' },
        { label: 'direct_split', ns: rr.direct_split, tag: rr.direct_split === 'done' ? ' ◀' : '' },
      ];
      railLines.forEach(({ label, ns: rns, tag }, ri) => {
        const rrow = nr + ri;
        if (rrow > logEnd) return;
        const rc = rns === 'done'     ? $.bold + $.green
                 : rns === 'active'   ? $.bold + $.green
                 : rns === 'rejected' ? $.dim + $.dred
                 : $.dgray;
        put(rrow, railCol, rc + label + tag + $.reset);
      });
    }

    // ✓ beside EXECUTE when done
    if (i === 3 && ns === 'done') {
      put(nr + 1, fc + nw + 1, $.bold + $.green + '✓ COMPLETE' + $.reset);
    }
  });

  // Receipt JSON pane — fills the empty space at the bottom of the
  // PAYMENT FLOW column. Renders the parsed `Split` and `NewFeedback`
  // event payload (from receipt-feed.ts), or "no settlement yet" until
  // a real tx lands.
  const receiptPaneTop = nodeRow(3) + 4; // after EXECUTE node + 1 gap
  const receiptPaneBottom = logEnd;
  const receiptCol = fc;
  const receiptWidth = w - receiptCol - 2;
  if (receiptPaneTop <= receiptPaneBottom && receiptWidth > 8) {
    put(receiptPaneTop, receiptCol, $.gray + '─ RECEIPT (on-chain) ' + '─'.repeat(Math.max(0, receiptWidth - 21)) + $.reset);
    const json = envelopeJson(receiptEnvelope);
    const lines = json.split('\n').slice(0, Math.max(0, receiptPaneBottom - receiptPaneTop));
    lines.forEach((ln, i) => {
      const rr = receiptPaneTop + 1 + i;
      if (rr > receiptPaneBottom) return;
      put(rr, receiptCol, $.dwhite + ln.slice(0, receiptWidth) + $.reset);
    });
  }

  // ── Log row (last legacy-flow log line) ───────────────────────────────────
  const logRow = ROW_LOG();
  put(logRow, 1, $.cyan + '╠' + '═'.repeat(w - 2) + '╣' + $.reset);

  // ── Receipt status row ────────────────────────────────────────────────────
  const receiptRow = ROW_RECEIPT();
  put(receiptRow, 1, $.cyan + '║' + $.reset);
  let receiptStatus: string;
  if (receiptEnvelope.status === 'no settlement yet') {
    receiptStatus = $.dwhite + 'receipt: no settlement yet — dispatch an intent or grant + run --live' + $.reset;
  } else if (receiptEnvelope.split) {
    const s = receiptEnvelope.split;
    receiptStatus = $.dgreen + `Split  blk=${s.blockNumber}  total=${s.totalAmount}  owner=${s.ownerCut}  k=${s.keeperCut}  z=${s.zhggCut}  c=${s.commonsCut}  tx=${shortHash(s.txHash)}` + $.reset;
  } else {
    receiptStatus = $.dwhite + 'receipt: pending decode' + $.reset;
  }
  put(receiptRow, 3, receiptStatus.slice(0, w * 4));
  put(receiptRow, w, $.cyan + '║' + $.reset);

  // ── Persistent hint row (slice D) ─────────────────────────────────────────
  // Always visible — eliminates the "what can I type" confusion the
  // operator hits the first time they sit at the dashboard. The
  // overlay (toggled via `?`) carries the full palette; this row is
  // the breadcrumb that points at it.
  const hintRow = ROW_HINT();
  put(hintRow, 1, $.cyan + '║' + $.reset);
  put(hintRow, 3, $.dwhite + PERSISTENT_HINT + $.reset);
  put(hintRow, w, $.cyan + '║' + $.reset);

  // ── Intent input row ──────────────────────────────────────────────────────
  const intentRow = ROW_INTENT();
  put(intentRow, 1, $.cyan + '║' + $.reset);
  const focused = intentMode === 'editing';
  const prompt = focused ? $.bold + $.cyan + 'intent> ' + $.reset : $.dwhite + 'intent> ' + $.reset;
  let body: string;
  if (intentBuffer.length === 0) {
    body = focused
      ? $.dwhite + 'try: "audit 1"  or  "audit 2"  or  "ask oracle ETH/USD"' + $.reset
      : $.dwhite + '(TAB to edit)' + $.reset;
  } else {
    body = $.white + intentBuffer + $.reset + (focused ? $.bold + $.green + '█' + $.reset : '');
  }
  let trail = '';
  if (intentHint.length > 0) trail = '  ' + $.yellow + intentHint + $.reset;
  else if (stagedIntent && stagedIntent.kind !== 'empty' && stagedIntent.kind !== 'unknown') {
    trail = '  ' + $.dgreen + 'staged: ' + formatStaged(stagedIntent) + ' [G] grant' + $.reset;
  }
  put(intentRow, 3, prompt + body + trail);
  put(intentRow, w, $.cyan + '║' + $.reset);

  // ── Status / footer ───────────────────────────────────────────────────────
  const statusRow = ROW_STATUS();
  // Slice C: phaseInfo is derived from `flow.nodes`, not a synthetic step
  // counter. It picks the deepest-touched node + state so the status line
  // shows whichever node was last moved by a real orchestrator emission.
  // No auto-play, no SPACE-driven mock advance.
  const phaseInfo =
    flow.nodes[3] === 'rejected' ? $.red + 'EXECUTE rejected' + $.reset :
    flow.nodes[3] === 'done'     ? $.green + 'EXECUTE done' + $.reset :
    flow.nodes[3] === 'active'   ? $.amber + 'EXECUTE active' + $.reset :
    flow.nodes[2] === 'rejected' ? $.red + 'RAILS rejected' + $.reset :
    flow.nodes[2] === 'active'   ? $.amber + 'RAILS active' + $.reset :
    flow.nodes[2] === 'done'     ? $.green + 'RAILS done' + $.reset :
    flow.nodes[1] === 'rejected' ? $.red + 'POLICY rejected' + $.reset :
    flow.nodes[1] === 'active'   ? $.amber + 'POLICY active' + $.reset :
    flow.nodes[1] === 'done'     ? $.green + 'POLICY done' + $.reset :
    flow.nodes[0] === 'active'   ? $.amber + 'INTENT active' + $.reset :
    flow.nodes[0] === 'done'     ? $.green + 'INTENT done' + $.reset :
                                   $.dwhite + 'WAITING (no intent dispatched)' + $.reset;
  const runInfo   = runningCommand === 'idle' ? '' : '  ' + $.amber + 'running ' + runningCommand + '…' + $.reset;
  put(statusRow, 1, $.cyan + '║' + $.reset);
  const left = $.dwhite + 'FLOW: ' + phaseInfo + runInfo + $.reset;
  const right = $.dwhite + '[?] help  [Enter] dispatch  [G] grant  [TAB] focus  [Q] quit' + $.reset;
  // Leave room for left + right; toast (if any) takes the centre.
  put(statusRow, 3, left);
  put(statusRow, Math.max(3, w - 70), right);
  put(statusRow, w, $.cyan + '║' + $.reset);
  put(ROW_FOOTER(), 1, $.cyan + '╚' + '═'.repeat(w - 2) + '╝' + $.reset);

  // ── Toast overlay (centred above the status row) ──────────────────────────
  if (toast) {
    const tc = toast.kind === 'ok' ? $.green : toast.kind === 'err' ? $.red : $.yellow;
    const text = ' ' + toast.text + ' ';
    const col = Math.max(2, Math.floor((w - text.length) / 2));
    put(receiptRow, col, tc + text + $.reset);
  }

  // ── Grant modal overlay — full-width so no bleed from right panel ───────
  if (grantModalOpen) {
    const mC = 1, mW = w;   // col 1→w, covers outer ║ border chars
    const innerW = mW - 2;
    const mH = grantModalLines.length + 4;
    const mR = Math.max(2, Math.floor((h - mH) / 2));
    const bc = $.bold + $.yellow;
    const titleFill = '═'.repeat(Math.max(0, innerW - ' SPEND CAP — confirm grant '.length));
    put(mR,     mC, bc + '╔ SPEND CAP — confirm grant ' + titleFill + '╗' + $.reset);
    grantModalLines.forEach((ln, i) => {
      put(mR + 1 + i, mC, bc + '║' + $.reset + $.bgNode + $.white + pad(' ' + ln, innerW) + $.reset + bc + '║' + $.reset);
    });
    const footerR = mR + 1 + grantModalLines.length;
    put(footerR,     mC, bc + '║' + $.reset + $.bgNode + $.dwhite + pad('   [Enter] confirm   [Esc] cancel   [Q] close', innerW) + $.reset + bc + '║' + $.reset);
    put(footerR + 1, mC, bc + '╚' + '═'.repeat(innerW) + '╝' + $.reset);
  }

  // ── Panel zoom overlays (Z = audit, X = flow) ────────────────────────────
  // Full-screen bordered overlay covering the main content. Esc dismisses.
  if (panelOverlay !== 'none') {
    const ovR = 2;                          // top row (below outer frame top)
    const ovC = 1;                          // col 1 — covers outer border chars
    const ovW = w;                          // full terminal width
    const ovH = h - 3;                      // rows available inside overlay
    const isAudit = panelOverlay === 'audit';
    const borderColor = isAudit ? $.bold + $.cyan : $.bold + $.green;
    const titleText = isAudit ? ' AUDIT TRAIL — full view ' : ' PAYMENT FLOW + RECEIPT — full view ';
    const topFill = '═'.repeat(Math.max(0, ovW - titleText.length - 2));
    // Draw box — col 1 to w so it overwrites the outer ║ border chars
    put(ovR, ovC, borderColor + '╔' + titleText + topFill + '╗' + $.reset);
    for (let r = ovR + 1; r < ovR + ovH; r++) {
      put(r, ovC, borderColor + '║' + $.reset + ' '.repeat(ovW - 2) + borderColor + '║' + $.reset);
    }
    put(ovR + ovH, ovC, borderColor + '╚' + '═'.repeat(ovW - 2) + '╝' + $.reset);
    // ESC hint in top-right corner of the top border
    const escHint = ' ESC to close ';
    put(ovR, ovC + ovW - escHint.length - 1, $.gray + escHint + $.reset);

    if (isAudit) {
      // Show as many audit rows as fit in the overlay
      const innerH = ovH - 2;  // leave 1 row padding top + bottom
      const rows = AUDIT.slice(-innerH);
      const nowMs2 = Date.now();
      rows.forEach((e, i) => {
        const r = ovR + 1 + i;
        const flash = nowMs2 < e.flashUntil;
        const ec = flash
          ? (e.ok === 'ok' ? $.bold + $.green : e.ok === 'err' ? $.bold + $.red : $.bold + $.cyan)
          : (e.ok === 'ok' ? $.green : e.ok === 'err' ? $.red : $.dwhite);
        const prefix = flash ? (e.ok === 'ok' ? '▶ ' : e.ok === 'err' ? '✕ ' : '◈ ') : '  ';
        const line = e.time + ' ' + pad(e.agent, 12) + ' ' + prefix + e.event;
        put(r, ovC + 2, ec + line.slice(0, ovW - 4) + $.reset);
      });
      if (AUDIT.length === 0) {
        put(ovR + 2, ovC + 2, $.dwhite + '(no events yet)' + $.reset);
      }
    } else {
      // Flow overlay: receipt JSON + status
      const json = envelopeJson(receiptEnvelope);
      const lines = json.split('\n');
      const innerH = ovH - 2;
      lines.slice(0, innerH).forEach((ln, i) => {
        put(ovR + 1 + i, ovC + 2, $.dwhite + ln.slice(0, ovW - 4) + $.reset);
      });
    }
  }

  // ── Help overlay — full-screen contextual command palette ────────────────
  if (helpOverlayOpen) {
    const helpBody: HelpLine[] = buildHelpLines();
    const ovR = 2, ovC = 1, ovW = w, ovH = h - 3;
    const bc = $.bold + $.dgreen;
    const titleTxt = ' COMMAND PALETTE — what\'s available right now ';
    const topFill = '═'.repeat(Math.max(0, ovW - titleTxt.length - 2));
    put(ovR, ovC, bc + '╔' + titleTxt + topFill + '╗' + $.reset);
    for (let r = ovR + 1; r < ovR + ovH; r++) {
      put(r, ovC, bc + '║' + $.reset + ' '.repeat(ovW - 2) + bc + '║' + $.reset);
    }
    put(ovR + ovH, ovC, bc + '╚' + '═'.repeat(ovW - 2) + '╝' + $.reset);
    const escHint2 = ' ESC to close ';
    put(ovR, ovC + ovW - escHint2.length - 1, $.gray + escHint2 + $.reset);
    const innerH = ovH - 2;
    helpBody.slice(0, innerH).forEach((hl, i) => {
      const r = ovR + 1 + i;
      const color = hl.kind === 'ok'     ? $.green
                  : hl.kind === 'locked' ? $.dred + $.dim
                  : hl.kind === 'warn'   ? $.yellow
                  : $.dwhite;
      put(r, ovC + 2, color + hl.text.slice(0, ovW - 4) + $.reset);
    });
  }

  return f;
}
