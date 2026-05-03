// ── OpenTUI renderer — replaces buildFrame() + process.stdout.write ──────────
//
// Creates the panel tree via @opentui/core's Yoga flexbox layout and
// exposes a single `updateUI(state: FrameState)` function. Callers
// set `.content` on TextRenderables each tick instead of writing raw
// ANSI escape sequences. The renderer's own loop handles repainting.

import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  StyledText,
  t, bold, dim, fg,
  type CliRenderer,
  type TextChunk,
} from '@opentui/core';
import type { FrameState } from './render.js';
import { AUDIT } from './audit-trail.js';
import { liveAgents } from './agent-status.js';
import { tryBuildLiveBundle } from './live-bundle.js';
import { PERSISTENT_HINT, buildHelpLines } from './help-overlay.js';
import { envelopeJson } from './receipt-feed.js';
import { shortHash, formatStaged } from './format.js';

// ── Colour palette (matches theme.ts RGB values) ─────────────────────────────
const CYAN   = fg('#00c8dc');
const GREEN  = fg('#00ff88');
const DGREEN = fg('#008c4b');
const WHITE  = fg('#dce4f0');
const DWHITE = fg('#949eaf');
const GRAY   = fg('#5a6473');
const DGRAY  = fg('#343c48');
const YELLOW = fg('#ffd237');
const RED    = fg('#ff5050');
const DRED   = fg('#782828');
const AMBER  = fg('#f59e0b');

// ── Singleton renderer + panel handles ───────────────────────────────────────
export let renderer: CliRenderer;

let headerText:     TextRenderable;
let agentsText:     TextRenderable;
let queueText:      TextRenderable;
let auditText:      TextRenderable;
let flowText:       TextRenderable;
let receiptText:    TextRenderable;
let hintText:       TextRenderable;
let intentText:     TextRenderable;
let statusText:     TextRenderable;
let helpBox:        BoxRenderable;
let helpText:       TextRenderable;
let grantBox:       BoxRenderable;
let grantText:      TextRenderable;
let auditOverlay:   BoxRenderable;
let auditOverlayText: TextRenderable;
let flowOverlay:    BoxRenderable;
let flowOverlayText:  TextRenderable;

// ── Init ─────────────────────────────────────────────────────────────────────

export async function initUI(): Promise<CliRenderer> {
  renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 12,
  });
  renderer.setBackgroundColor('#080e16');
  buildLayout();
  renderer.start();
  return renderer;
}

// ── Layout ───────────────────────────────────────────────────────────────────

function B(id: string, opts: Record<string, unknown>): BoxRenderable {
  return new BoxRenderable(renderer, { id, ...opts } as ConstructorParameters<typeof BoxRenderable>[1]);
}
function T(id: string): TextRenderable {
  return new TextRenderable(renderer, { id });
}

function buildLayout(): void {
  const root = renderer.root;

  // ── Header (3 rows tall) ──────────────────────────────────────────────────
  const headerBox = B('header', {
    height: 3,
    flexDirection: 'column',
    justifyContent: 'center',
    border: true,
    borderStyle: 'single',
    borderColor: '#00c8dc',
    backgroundColor: '#0b1220',
    paddingX: 1,
  });
  headerText = T('header-text');
  headerBox.add(headerText);
  root.add(headerBox);

  // ── Top row: iNFT AGENTS | ACTION QUEUE ──────────────────────────────────
  const topRow = B('top-row', { flexDirection: 'row', height: 6 });

  const agentsBox = B('agents-box', {
    width: '42%',
    border: true, borderStyle: 'single', borderColor: '#00c8dc',
    backgroundColor: '#0b1220',
    title: ' ◈ iNFT AGENTS ',
    titleAlignment: 'left',
    paddingX: 1,
    overflow: 'hidden',
  });
  agentsText = T('agents-text');
  agentsBox.add(agentsText);

  const queueBox = B('queue-box', {
    flexGrow: 1,
    border: true, borderStyle: 'single', borderColor: '#00c8dc',
    backgroundColor: '#0b1220',
    title: ' ◈ ACTION QUEUE ',
    titleAlignment: 'left',
    paddingX: 1,
    overflow: 'hidden',
  });
  queueText = T('queue-text');
  queueBox.add(queueText);

  topRow.add(agentsBox);
  topRow.add(queueBox);
  root.add(topRow);

  // ── Main row: AUDIT TRAIL | PAYMENT FLOW + RECEIPT ───────────────────────
  const mainRow = B('main-row', {
    flexDirection: 'row',
    flexGrow: 1,
    overflow: 'hidden',
  });

  const auditBox = B('audit-box', {
    width: '42%',
    border: true, borderStyle: 'single', borderColor: '#00c8dc',
    backgroundColor: '#080e16',
    title: ' ◈ AUDIT TRAIL  [Z] ',
    titleAlignment: 'left',
    paddingX: 1,
    overflow: 'hidden',
  });
  auditText = T('audit-text');
  auditBox.add(auditText);

  const flowBox = B('flow-box', {
    flexGrow: 1,
    border: true, borderStyle: 'single', borderColor: '#00c8dc',
    backgroundColor: '#080e16',
    title: ' ◈ PAYMENT FLOW + RECEIPT  [X] ',
    titleAlignment: 'left',
    paddingX: 1,
    overflow: 'hidden',
  });
  flowText = T('flow-text');
  flowBox.add(flowText);

  mainRow.add(auditBox);
  mainRow.add(flowBox);
  root.add(mainRow);

  // ── Bottom bar ────────────────────────────────────────────────────────────
  const bottomBar = B('bottom', {
    flexDirection: 'column',
    height: 6,
    border: true, borderStyle: 'single', borderColor: '#00c8dc',
    backgroundColor: '#0b1220',
    paddingX: 1,
    overflow: 'hidden',
  });
  receiptText = T('receipt-text');
  hintText    = T('hint-text');
  intentText  = T('intent-text');
  statusText  = T('status-text');
  bottomBar.add(receiptText);
  bottomBar.add(hintText);
  bottomBar.add(intentText);
  bottomBar.add(statusText);
  root.add(bottomBar);

  // ── Help overlay (absolute, zIndex 20) ───────────────────────────────────
  helpBox = B('help-overlay', {
    position: 'absolute',
    top: 2, left: '5%',
    width: '90%', height: '85%',
    zIndex: 20,
    visible: false,
    border: true, borderStyle: 'single', borderColor: '#00c8dc',
    backgroundColor: '#0b1220',
    title: '  ── COMMAND PALETTE ──  [?] or Esc to close  ',
    titleAlignment: 'center',
    overflow: 'hidden',
    paddingX: 2, paddingY: 1,
  });
  helpText = T('help-text');
  helpBox.add(helpText);
  root.add(helpBox);

  // ── Grant modal (absolute, zIndex 30) ────────────────────────────────────
  grantBox = B('grant-modal', {
    position: 'absolute',
    top: '30%', left: '25%',
    width: '50%',
    zIndex: 30,
    visible: false,
    border: true, borderStyle: 'double', borderColor: '#ffd237',
    backgroundColor: '#0b1220',
    title: '  GRANT SPEND CAP  ',
    titleAlignment: 'center',
    paddingX: 2, paddingY: 1,
  });
  grantText = T('grant-text');
  grantBox.add(grantText);
  root.add(grantBox);

  // ── Audit full-screen overlay [Z] ────────────────────────────────────────
  auditOverlay = B('audit-overlay', {
    position: 'absolute',
    top: 3, left: 0,
    width: '100%', height: '85%',
    zIndex: 25,
    visible: false,
    border: true, borderStyle: 'single', borderColor: '#00c8dc',
    backgroundColor: '#080e16',
    title: ' ◈ AUDIT TRAIL  [Z to close] ',
    titleAlignment: 'left',
    paddingX: 1,
    overflow: 'hidden',
  });
  auditOverlayText = T('audit-overlay-text');
  auditOverlay.add(auditOverlayText);
  root.add(auditOverlay);

  // ── Flow full-screen overlay [X] ─────────────────────────────────────────
  flowOverlay = B('flow-overlay', {
    position: 'absolute',
    top: 3, left: 0,
    width: '100%', height: '85%',
    zIndex: 25,
    visible: false,
    border: true, borderStyle: 'single', borderColor: '#00c8dc',
    backgroundColor: '#080e16',
    title: ' ◈ PAYMENT FLOW + RECEIPT  [X to close] ',
    titleAlignment: 'left',
    paddingX: 1,
    overflow: 'hidden',
  });
  flowOverlayText = T('flow-overlay-text');
  flowOverlay.add(flowOverlayText);
  root.add(flowOverlay);
}

// ── Styled text helpers ───────────────────────────────────────────────────────

function joinLines(lines: StyledText[]): StyledText {
  if (lines.length === 0) return t``;
  const nl: TextChunk = { __isChunk: true, text: '\n', attributes: 0 };
  return new StyledText(
    lines.flatMap((l, i) => i === 0 ? [...l.chunks] : [nl, ...l.chunks]),
  );
}

// Merge StyledText / TextChunk / string pieces into a single StyledText.
function concat(...parts: Array<StyledText | TextChunk | string>): StyledText {
  const chunks: TextChunk[] = [];
  for (const p of parts) {
    if (typeof p === 'string') {
      if (p) chunks.push({ __isChunk: true, text: p, attributes: 0 });
    } else if (p instanceof StyledText) {
      chunks.push(...p.chunks);
    } else {
      chunks.push(p);
    }
  }
  return new StyledText(chunks);
}

// ── Content builders ──────────────────────────────────────────────────────────

function buildHeader(state: FrameState): StyledText {
  const now    = new Date().toLocaleTimeString('en-GB');
  const bundle = tryBuildLiveBundle();
  const mode   = bundle
    ? (bundle.inferenceReady ? 'MODE:live' : 'MODE:inference-blocked')
    : 'MODE:env-incomplete';
  const modeColor = bundle?.inferenceReady ? GREEN : bundle ? YELLOW : RED;
  if (state.balanceHint) {
    return t`${bold(WHITE('zhgg runtime'))}    ${AMBER(state.balanceHint)}  ${modeColor(mode)}  ${DWHITE(`│  ${now}`)}`;
  }
  return t`${bold(WHITE('zhgg runtime'))}  ${modeColor(mode)}  ${DWHITE(`│  ${now}`)}`;
}

function buildAgents(state: FrameState): StyledText {
  const agents = liveAgents();
  if (agents.length === 0) return t`${DWHITE('(no agents registered)')}`;
  const { stagedIntent: si, runningCommand: rc } = state;
  const lines = agents.map(a => {
    const isSubject = si?.kind === 'audit' && si.tokenId === a.tokenId;
    const isOracle  = a.tokenId === 2n;
    const isSwap    = a.tokenId === 3n;
    let glyph = '○', label = 'idle', color = DWHITE;
    if (rc === 'audit') {
      if (isSubject)     { glyph = '●'; label = 'SUBJECT  ←'; color = GREEN; }
      else if (isOracle) { glyph = '◎'; label = 'CONSULTED ↗'; color = GREEN; }
    } else if (rc === 'ask-oracle' && isOracle) {
      glyph = '●'; label = 'QUERIED  ←'; color = GREEN;
    } else if (rc === 'swap' && isSwap) {
      glyph = '●'; label = 'EXECUTING ←'; color = GREEN;
    } else if (si) {
      if ((si.kind === 'audit' && isSubject) ||
          (si.kind === 'ask-oracle' && isOracle) ||
          (si.kind === 'swap' && isSwap)) {
        glyph = '◎'; label = 'STAGED   →'; color = YELLOW;
      }
    }
    const name  = a.name.padEnd(14);
    const tid   = `#${a.tokenId}`.padEnd(3);
    const scope = a.scope.slice(0, 34).padEnd(34);
    return t`${color(`${glyph} ${name} ${tid} ${scope} ${label}`)}`;
  });
  return joinLines(lines);
}

function buildQueue(state: FrameState): StyledText {
  const { stagedIntent: si, runningCommand: rc } = state;
  if (!si && rc === 'idle') {
    return t`${DWHITE('  (queue empty — type an intent below)')}`;
  }
  const headMap: Record<string, StyledText> = {
    'audit':    t`audit-agent ${CYAN('→')} running topic=${si?.kind === 'audit' ? si.topic : '?'}`,
    'ask-oracle': t`oracle-agent ${CYAN('→')} query in flight`,
    'swap':     t`swap-agent ${CYAN('→')} swap in flight`,
    'transfer': t`transfer-agent ${CYAN('→')} tx in flight`,
    'kh':       t`keeperhub-agent ${CYAN('→')} x402 call in flight`,
    'mint':     t`mint-agent ${CYAN('→')} iNFT minting`,
  };
  const headline = headMap[rc] ?? (si ? t`${WHITE(formatStaged(si))}` : t`${DWHITE('idle')}`);
  const statusLine = rc !== 'idle'
    ? t`  ${GREEN('status=running')}   ${DWHITE('(await results in AUDIT TRAIL)')}`
    : t`  ${YELLOW('status=staged')}   ${DWHITE('[Enter] dispatch  [G] grant  [Esc] clear')}`;
  return concat(t`  ${CYAN('▸')} `, headline, t`\n`, statusLine);
}

function buildAudit(): StyledText {
  if (AUDIT.length === 0) {
    return t`${DWHITE('(no events — type an intent and Enter to dispatch)')}`;
  }
  const nowMs = Date.now();
  const lines = AUDIT.slice(-80).map(e => {
    const flash = nowMs < e.flashUntil;
    const color = flash
      ? (e.ok === 'ok' ? GREEN : e.ok === 'err' ? RED : CYAN)
      : (e.ok === 'ok' ? DGREEN : e.ok === 'err' ? DRED : DWHITE);
    const prefix = flash ? (e.ok === 'ok' ? '▶ ' : e.ok === 'err' ? '✕ ' : '◈ ') : '  ';
    const line = `${e.time} ${e.agent.padEnd(10)} ${prefix}${e.event}`.slice(0, 120);
    return t`${color(line)}`;
  });
  return joinLines(lines);
}

function buildFlow(state: FrameState): StyledText {
  const { flow, receiptEnvelope } = state;
  const labels = ['INTENT', 'POLICY', 'RAILS', 'EXECUTE'];
  const parts: StyledText[] = [];

  // Rail pill
  const railStr = flow.settledRail === 'x402'
    ? ' RAIL: x402 '
    : flow.settledRail === 'direct_split'
      ? ' RAIL: direct_split '
      : ' RAIL: — ';
  const railColor = flow.settledRail !== null
    ? (s: string): TextChunk => bold(GREEN(s))
    : GRAY;
  parts.push(t`${railColor(railStr)}\n`);

  flow.nodes.forEach((ns, i) => {
    const active = ns === 'active', done = ns === 'done', rej = ns === 'rejected';
    const dbl = active || done;
    const b = dbl
      ? { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' }
      : { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' };
    const col = (active || done)
      ? (s: string): TextChunk => bold(GREEN(s))
      : rej
        ? (s: string): TextChunk => bold(RED(s))
        : GRAY;
    const lbl = (' ' + labels[i]!).padEnd(12);

    parts.push(t`${col(b.tl + b.h.repeat(12) + b.tr)}`);

    if (i === 2) {
      // RAILS node — show rail options beside
      const rr = flow.rails;
      const c4 = rr.x402 === 'done' ? GREEN : rr.x402 === 'active' ? YELLOW : DGRAY;
      const cd = rr.direct_split === 'done' ? GREEN : rr.direct_split === 'active' ? YELLOW : DGRAY;
      parts.push(t`${col(b.v + lbl + b.v)}  ${c4('x402')}${rr.x402 === 'done' ? GREEN(' ◀') : ''}`);
      parts.push(t`${col(b.bl + b.h.repeat(12) + b.br)}  ${cd('direct_split')}${rr.direct_split === 'done' ? GREEN(' ◀') : ''}`);
    } else {
      parts.push(t`${col(b.v + lbl + b.v)}`);
      parts.push(t`${col(b.bl + b.h.repeat(12) + b.br)}`);
      if (i === 3 && done) parts.push(t`${bold(GREEN('  ✓ COMPLETE'))}`);
    }

    if (i < 3) {
      parts.push(ns === 'done'
        ? t`${bold(GREEN('     ▼'))}`
        : t`${DGRAY('     │')}`);
    }
  });

  // Receipt pane
  parts.push(t`\n${GRAY('─ RECEIPT ──────────────────')}`);
  envelopeJson(receiptEnvelope).split('\n').slice(0, 8).forEach(ln =>
    parts.push(t`${DWHITE(ln.slice(0, 58))}`),
  );

  return joinLines(parts);
}

function buildReceipt(state: FrameState): StyledText {
  const re = state.receiptEnvelope;
  if (re.status === 'no settlement yet') {
    return t`${DWHITE('receipt: no settlement yet — dispatch an intent or run --live')}`;
  }
  if (re.split) {
    const s = re.split;
    return t`${DGREEN(`Split  blk=${s.blockNumber}  total=${s.totalAmount}  owner=${s.ownerCut}  tx=${shortHash(s.txHash)}`)}`;
  }
  return t`${DWHITE('receipt: pending decode')}`;
}

function buildIntent(state: FrameState): StyledText {
  const focused = state.intentMode === 'editing';
  const prompt  = focused ? t`${bold(CYAN('intent> '))}` : t`${DWHITE('intent> ')}`;
  let body: StyledText;
  if (state.intentBuffer.length === 0) {
    body = focused
      ? t`${DWHITE('try: "audit 1"  or  "ask oracle ETH/USD"')}`
      : t`${DWHITE('(TAB to edit)')}`;
  } else {
    body = focused
      ? t`${WHITE(state.intentBuffer)}${bold(GREEN('█'))}`
      : t`${WHITE(state.intentBuffer)}`;
  }
  let trail: StyledText = t``;
  if (state.intentHint) {
    trail = t`  ${YELLOW(state.intentHint)}`;
  } else if (state.stagedIntent && state.stagedIntent.kind !== 'empty' && state.stagedIntent.kind !== 'unknown') {
    trail = t`  ${DGREEN(`staged: ${formatStaged(state.stagedIntent)} [G] grant`)}`;
  }
  return concat(prompt, body, trail);
}

function buildStatus(state: FrameState): StyledText {
  if (state.toast) {
    const c = state.toast.kind === 'ok' ? GREEN : state.toast.kind === 'err' ? RED : CYAN;
    return t`  ${c(state.toast.text)}`;
  }
  const nodes = state.flow.nodes;
  let deepest = -1, deepNs = nodes[0]!;
  nodes.forEach((ns, i) => { if (ns !== 'off' && i > deepest) { deepest = i; deepNs = ns; } });
  const phaseLabels = ['INTENT', 'POLICY', 'RAILS', 'EXECUTE'];
  const label = deepest >= 0 ? phaseLabels[deepest]! : 'idle';
  const pc = deepNs === 'done' ? GREEN : deepNs === 'active' ? YELLOW : deepNs === 'rejected' ? RED : DWHITE;
  return t`  ${pc(`phase=${label}  node=${deepNs ?? 'idle'}`)}   ${GRAY('?·R·G·TAB·Q')}`;
}

// ── Main update (called each frame + on every state mutation) ─────────────────

export function updateUI(state: FrameState): void {
  headerText.content  = buildHeader(state);
  agentsText.content  = buildAgents(state);
  queueText.content   = buildQueue(state);
  auditText.content   = buildAudit();
  flowText.content    = buildFlow(state);
  receiptText.content = buildReceipt(state);
  hintText.content    = t`${DWHITE(PERSISTENT_HINT)}`;
  intentText.content  = buildIntent(state);
  statusText.content  = buildStatus(state);

  // Help overlay
  helpBox.visible = state.helpOverlayOpen;
  if (state.helpOverlayOpen) {
    const ls = buildHelpLines().map(l => {
      const c = l.kind === 'ok' ? GREEN : l.kind === 'warn' ? YELLOW : l.kind === 'locked' ? DWHITE : GRAY;
      return t`${c(l.text)}`;
    });
    helpText.content = joinLines(ls);
  }

  // Grant modal
  grantBox.visible = state.grantModalOpen;
  if (state.grantModalOpen && state.grantModalLines.length > 0) {
    grantText.content = joinLines(state.grantModalLines.map(l => t`${DWHITE(l)}`));
  }

  // Panel zoom overlays [Z] = audit, [X] = flow
  auditOverlay.visible = state.panelOverlay === 'audit';
  flowOverlay.visible  = state.panelOverlay === 'flow';
  if (state.panelOverlay === 'audit') {
    auditOverlayText.content = buildAudit();
  } else if (state.panelOverlay === 'flow') {
    flowOverlayText.content = buildFlow(state);
  }

  renderer.requestRender();
}
