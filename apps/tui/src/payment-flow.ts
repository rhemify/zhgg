// zhgg — interactive payment flow demo
// aesthetic: phosphor-green CRT terminal, circuit-board node animation

const E = "\x1b"
const out = (s: string) => process.stdout.write(s)
const move = (r: number, c: number) => `${E}[${r};${c}H`
const clrLine = `${E}[2K`

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const c = {
  reset:   `${E}[0m`,
  bold:    `${E}[1m`,
  dim:     `${E}[2m`,
  green:   `${E}[38;2;0;255;136m`,
  dgreen:  `${E}[38;2;0;120;70m`,
  gray:    `${E}[38;2;55;60;65m`,
  dgray:   `${E}[38;2;30;32;35m`,
  white:   `${E}[38;2;200;205;215m`,
  dwhite:  `${E}[38;2;90;95;105m`,
  yellow:  `${E}[38;2;255;210;60m`,
  indigo:  `${E}[38;2;140;130;255m`,
  amber:   `${E}[38;2;245;158;11m`,
  red:     `${E}[38;2;255;85;85m`,
  bgDark:  `${E}[48;2;4;6;8m`,
  bgNode:  `${E}[48;2;8;14;10m`,
  bgSel:   `${E}[48;2;0;35;20m`,
}

// ── Layout constants (1-indexed rows/cols) ────────────────────────────────────
// Header: rows 1-3
// Diagram: rows 5-27
// Log: rows 29-34
// Controls: row 36

const COL_INTENT    = 4
const COL_POLICY    = 26
const COL_RAILSEL   = 50
const ROW_TOP_NODES = 5

const COL_X402      = 34
const COL_MPP       = 52
const COL_GAS       = 68
const ROW_RAILS     = 15

const COL_EXECUTE   = 34
const ROW_EXECUTE   = 22

const LOG_START = 30
const LOG_LINES = 4

// ── Node state ────────────────────────────────────────────────────────────────
type NodeState = "off" | "active" | "done" | "rejected"

interface State {
  intent:    NodeState
  policy:    NodeState
  railsel:   NodeState
  x402:      NodeState
  mpp:       NodeState
  gas:       NodeState
  execute:   NodeState
  step:      number
  packet:    { row: number; col: number; visible: boolean } | null
  log:       string[]
  autoPlay:  boolean
  done:      boolean
}

const initial = (): State => ({
  intent: "off", policy: "off", railsel: "off",
  x402: "off", mpp: "off", gas: "off", execute: "off",
  step: 0, packet: null, log: [], autoPlay: false, done: false,
})

let state = initial()

// ── Step definitions ──────────────────────────────────────────────────────────
const STEPS: Array<{
  label: string
  logEntry: string
  apply: (s: State) => void
  packet?: { row: number; fromCol: number; toCol: number } | { col: number; fromRow: number; toRow: number }
}> = [
  {
    label: "Parse intent",
    logEntry: `[14:02:31] INTENT   swap 100 USDC → ETH   intent=simple_swap  risk=LOW`,
    apply: (s) => { s.intent = "active" },
  },
  {
    label: "Policy check",
    logEntry: `[14:02:31] POLICY   ExecutionContext created   scope=[swap,read]   ttl=60m`,
    apply: (s) => { s.intent = "done"; s.policy = "active" },
    packet: { row: ROW_TOP_NODES + 2, fromCol: COL_INTENT + 12, toCol: COL_POLICY - 1 },
  },
  {
    label: "Policy passed",
    logEntry: `[14:02:32] POLICY   check PASSED   risk_tier=LOW   action=auto_execute`,
    apply: (s) => { s.policy = "done"; s.railsel = "active" },
    packet: { row: ROW_TOP_NODES + 2, fromCol: COL_POLICY + 12, toCol: COL_RAILSEL - 1 },
  },
  {
    label: "Evaluate rails",
    logEntry: `[14:02:32] RAILS    evaluating   x402=$0.001   MPP=$0.050   GAS=$0.002`,
    apply: (s) => { s.railsel = "done"; s.x402 = "active"; s.mpp = "active"; s.gas = "active" },
    packet: { col: COL_RAILSEL + 7, fromRow: ROW_TOP_NODES + 5, toRow: ROW_RAILS - 1 },
  },
  {
    label: "Select x402",
    logEntry: `[14:02:32] RAILS    x402 selected — cheapest route   saving $0.049 vs MPP`,
    apply: (s) => { s.x402 = "active"; s.mpp = "rejected"; s.gas = "rejected" },
  },
  {
    label: "Execute swap",
    logEntry: `[14:02:33] EXECUTE  Uniswap v3   in=100 USDC   out=0.0412 ETH   slippage=0.05%`,
    apply: (s) => { s.x402 = "done"; s.execute = "active" },
    packet: { col: COL_X402 + 7, fromRow: ROW_RAILS + 5, toRow: ROW_EXECUTE - 1 },
  },
  {
    label: "Confirmed",
    logEntry: `[14:02:33] EXECUTE  tx=0x4a2f…9b1c   confirmed   block=21482904   ✓ COMPLETE`,
    apply: (s) => { s.execute = "done"; s.done = true },
  },
]

// ── Box drawing ───────────────────────────────────────────────────────────────
const BOX = {
  off: { tl:"┌",tr:"┐",bl:"└",br:"┘",h:"─",v:"│" },
  on:  { tl:"╔",tr:"╗",bl:"╚",br:"╝",h:"═",v:"║" },
}

function nodeColor(ns: NodeState): string {
  if (ns === "active") return c.bold + c.green + c.bgSel
  if (ns === "done")   return c.dgreen
  if (ns === "rejected") return c.red + c.dim
  return c.gray
}

function boxChars(ns: NodeState) {
  return ns === "active" ? BOX.on : BOX.off
}

function drawBox(
  row: number, col: number,
  width: number, height: number,
  lines: string[], ns: NodeState
) {
  const color = nodeColor(ns)
  const bc = boxChars(ns)
  const inner = width - 2

  // top border
  out(move(row, col) + color + bc.tl + bc.h.repeat(inner) + bc.tr + c.reset)

  // inner rows
  for (let i = 0; i < height - 2; i++) {
    const text = (lines[i] ?? "").padEnd(inner).slice(0, inner)
    const lineColor = ns === "active" ? c.bold + c.green : ns === "done" ? c.dgreen : ns === "rejected" ? c.red + c.dim : c.gray
    out(move(row + 1 + i, col) + color + bc.v + c.reset + lineColor + text + c.reset + color + bc.v + c.reset)
  }

  // bottom border
  out(move(row + height - 1, col) + color + bc.bl + bc.h.repeat(inner) + bc.br + c.reset)
}

// ── Wires ─────────────────────────────────────────────────────────────────────
function wireH(row: number, fromCol: number, toCol: number, lit: boolean) {
  const col = lit ? c.dgreen : c.dgray
  const arrow = lit ? c.green + c.bold : c.dgray
  const wire = "─".repeat(Math.max(0, toCol - fromCol - 1))
  out(move(row, fromCol) + col + wire + arrow + "▶" + c.reset)
}

function wireV(col: number, fromRow: number, toRow: number, lit: boolean) {
  const color = lit ? c.dgreen : c.dgray
  for (let r = fromRow; r <= toRow; r++) {
    out(move(r, col) + color + "│" + c.reset)
  }
  if (toRow >= fromRow) {
    out(move(toRow, col) + (lit ? c.green + c.bold : c.dgray) + "▼" + c.reset)
  }
}

function wireSplit(row: number, col: number, lit: boolean) {
  const color = lit ? c.dgreen : c.dgray
  out(move(row, col) + color + "├" + c.reset)
}

// ── Packet animation ──────────────────────────────────────────────────────────
let packetFrame = 0

function drawPacket() {
  if (!state.packet?.visible) return
  const p = state.packet
  packetFrame = (packetFrame + 1) % 3
  const glyph = ["◉", "●", "◎"][packetFrame]!
  out(move(p.row, p.col) + c.bold + c.yellow + glyph + c.reset)
}

// ── Header ────────────────────────────────────────────────────────────────────
function drawHeader() {
  const title = "  zhgg  ›  PAYMENT FLOW SIMULATION"
  const hint  = state.done ? "COMPLETE" : state.autoPlay ? "AUTO" : "MANUAL"
  const w = process.stdout.columns || 100
  const pad = " ".repeat(Math.max(0, w - title.length - hint.length - 2))

  out(move(1, 1) + c.bold + c.green + "╔" + "═".repeat(w - 2) + "╗" + c.reset)
  out(move(2, 1) + c.bold + c.green + "║" + c.reset)
  out(c.white + c.bold + title)
  out(c.reset + c.dwhite + pad)
  const hintColor = state.done ? c.green : state.autoPlay ? c.yellow : c.dwhite
  out(hintColor + hint + "  " + c.bold + c.green + "║" + c.reset)
  out(move(3, 1) + c.bold + c.green + "╚" + "═".repeat(w - 2) + "╝" + c.reset)
}

// ── Main diagram ──────────────────────────────────────────────────────────────
function drawDiagram() {
  const s = state

  // Top row nodes
  drawBox(ROW_TOP_NODES, COL_INTENT, 14, 6, [
    " INTENT     ",
    "            ",
    " swap       ",
    " USDC→ETH   ",
  ], s.intent)

  drawBox(ROW_TOP_NODES, COL_POLICY, 14, 6, [
    " POLICY     ",
    "            ",
    " scope:     ",
    " [swap,read]",
  ], s.policy)

  drawBox(ROW_TOP_NODES, COL_RAILSEL, 16, 6, [
    " RAIL SELECT  ",
    "              ",
    " comparing    ",
    " 3 rails      ",
  ], s.railsel)

  // Horizontal wires top row
  const p1Lit = s.policy !== "off" || s.railsel !== "off" || s.x402 !== "off"
  const p2Lit = s.railsel !== "off" || s.x402 !== "off"
  wireH(ROW_TOP_NODES + 2, COL_INTENT + 14,  COL_POLICY - 1,   p1Lit)
  wireH(ROW_TOP_NODES + 2, COL_POLICY + 14,  COL_RAILSEL - 1,  p2Lit)

  // Vertical wire from rail select down
  const downLit = s.x402 !== "off" || s.mpp !== "off" || s.gas !== "off"
  wireV(COL_RAILSEL + 7, ROW_TOP_NODES + 6, ROW_RAILS - 2, downLit)

  // Branch split
  const splitRow = ROW_RAILS - 2
  const splitCol = COL_RAILSEL + 7
  if (downLit) {
    out(move(splitRow, COL_X402 + 7) + c.dgreen + "┌" + "─".repeat(splitCol - COL_X402 - 8) + "┤" + "─".repeat(COL_MPP + 7 - splitCol - 1) + "┐" + c.reset)
    // horz to gas
    out(move(splitRow, COL_MPP + 8) + c.dgray + "─".repeat(COL_GAS + 7 - COL_MPP - 8) + "┐" + c.reset)
  } else {
    out(move(splitRow, COL_X402 + 7) + c.dgray + "┌" + "─".repeat(splitCol - COL_X402 - 8) + "┼" + "─".repeat(COL_MPP + 7 - splitCol - 1) + "┐" + c.reset)
    out(move(splitRow, COL_MPP + 8) + c.dgray + "─".repeat(COL_GAS + 7 - COL_MPP - 8) + "┐" + c.reset)
  }

  // Short vertical drops to rail nodes
  for (const col of [COL_X402 + 7, COL_MPP + 7, COL_GAS + 7]) {
    out(move(splitRow + 1, col) + (downLit ? c.dgreen : c.dgray) + "│" + c.reset)
  }

  // Rail nodes
  const x402Lines = ["  x402    ", "          ", ` $0.001   `, "          "]
  const mppLines  = ["  MPP     ", "          ", ` $0.050   `, "          "]
  const gasLines  = ["  ONCHAIN ", "   GAS    ", ` $0.002   `, "          "]

  drawBox(ROW_RAILS, COL_X402, 14, 6, x402Lines, s.x402)
  drawBox(ROW_RAILS, COL_MPP,  14, 6, mppLines,  s.mpp)
  drawBox(ROW_RAILS, COL_GAS,  14, 6, gasLines,  s.gas)

  // Selected label
  if (s.x402 === "active" || s.x402 === "done") {
    out(move(ROW_RAILS + 2, COL_X402 + 15) + c.green + c.bold + "◀ SELECTED" + c.reset)
  }

  // Vertical wire x402 → execute
  const execLit = s.execute !== "off"
  wireV(COL_X402 + 7, ROW_RAILS + 6, ROW_EXECUTE - 1, execLit)

  // Execute node
  drawBox(ROW_EXECUTE, COL_EXECUTE, 14, 6, [
    " EXECUTE    ",
    "            ",
    " uniswap    ",
    " v3 swap    ",
  ], s.execute)

  // Done checkmark
  if (s.done) {
    out(move(ROW_EXECUTE + 2, COL_EXECUTE + 15) + c.bold + c.green + "✓ DONE" + c.reset)
  }
}

// ── Log panel ─────────────────────────────────────────────────────────────────
function drawLog() {
  const divider = "─".repeat((process.stdout.columns || 100) - 2)
  out(move(LOG_START - 1, 2) + c.dgray + divider + c.reset)

  const entries = state.log.slice(-LOG_LINES)
  for (let i = 0; i < LOG_LINES; i++) {
    out(move(LOG_START + i, 2) + clrLine)
    const entry = entries[i]
    if (!entry) continue

    const isLast = i === entries.length - 1
    const prefix = isLast ? c.green + c.bold + "▸ " : c.dwhite + "  "
    const entryColor = isLast ? c.white : c.dwhite
    out(move(LOG_START + i, 2) + prefix + c.reset + entryColor + entry + c.reset)
  }

  out(move(LOG_START + LOG_LINES, 2) + c.dgray + divider + c.reset)
}

// ── Controls ──────────────────────────────────────────────────────────────────
function drawControls() {
  const ctrlRow = LOG_START + LOG_LINES + 2
  const parts = [
    [" SPACE ", "step"],
    [" A ", "auto-play"],
    [" R ", "reset"],
    [" Q ", "quit"],
  ]
  out(move(ctrlRow, 2))
  for (const [key, label] of parts) {
    out(c.bgSel + c.bold + c.green + key + c.reset + c.dwhite + " " + label + "   " + c.reset)
  }

  if (state.autoPlay) {
    out(c.bold + c.yellow + "  ◉ AUTO-PLAYING" + c.reset)
  }
  if (state.done) {
    out(c.bold + c.green + "  ✓ FLOW COMPLETE" + c.reset)
  }
}

// ── Full render ───────────────────────────────────────────────────────────────
function render() {
  out(E + "[?25l")           // hide cursor
  out(E + "[H")              // home (no clear — reduces flicker)
  drawHeader()
  drawDiagram()
  drawLog()
  drawControls()
  if (state.packet?.visible) drawPacket()
}

// ── Step logic ────────────────────────────────────────────────────────────────
function advance() {
  if (state.done) return
  const step = STEPS[state.step]
  if (!step) return

  step.apply(state)
  state.log.push(step.logEntry)

  // Trigger packet animation if this step has a packet path
  if (step.packet) {
    const pkt = step.packet
    if ("fromCol" in pkt) {
      // horizontal travel
      const startCol = pkt.fromCol
      const endCol   = pkt.toCol
      let col = startCol
      const interval = setInterval(() => {
        if (col > endCol) { clearInterval(interval); state.packet = null; render(); return }
        state.packet = { row: pkt.row, col, visible: true }
        render()
        col += 2
      }, 40)
    } else {
      // vertical travel
      const startRow = pkt.fromRow
      const endRow   = pkt.toRow
      let row = startRow
      const interval = setInterval(() => {
        if (row > endRow) { clearInterval(interval); state.packet = null; render(); return }
        state.packet = { row, col: pkt.col, visible: true }
        render()
        row++
      }, 60)
    }
  }

  state.step++
  render()
}

// ── Keyboard input ────────────────────────────────────────────────────────────
let autoTimer: ReturnType<typeof setInterval> | null = null

function setAutoPlay(on: boolean) {
  state.autoPlay = on
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null }
  if (on && !state.done) {
    autoTimer = setInterval(() => {
      if (state.done) { setAutoPlay(false); return }
      advance()
    }, 1600)
  }
}

process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.setEncoding("utf8")

process.stdin.on("data", (key: string) => {
  if (key === "q" || key === "Q" || key === "\x03") {
    cleanup()
    process.exit(0)
  }
  if (key === " " || key === "\r") {
    setAutoPlay(false)
    advance()
  }
  if (key === "a" || key === "A") {
    setAutoPlay(!state.autoPlay)
    render()
  }
  if (key === "r" || key === "R") {
    setAutoPlay(false)
    state = initial()
    render()
  }
})

// ── Cleanup ───────────────────────────────────────────────────────────────────
function cleanup() {
  if (autoTimer) clearInterval(autoTimer)
  out(E + "[?25h")   // show cursor
  out(E + "[2J")     // clear
  out(E + "[H")
}

process.on("exit", cleanup)
process.on("SIGINT", () => { cleanup(); process.exit(0) })

// Resize handler
process.stdout.on("resize", render)

// ── Start ─────────────────────────────────────────────────────────────────────
out(E + "[2J")  // initial clear
render()
