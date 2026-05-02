// zhgg — unified TUI
// 4-panel layout with interactive payment flow in bottom-right
// Requires: 120×36 terminal (warns if smaller)

// ── ANSI primitives ───────────────────────────────────────────────────────────

const E  = "\x1b"
const at = (r: number, c: number) => `${E}[${r};${c}H`
const fg = (r: number, g: number, b: number) => `${E}[38;2;${r};${g};${b}m`
const bg = (r: number, g: number, b: number) => `${E}[48;2;${r};${g};${b}m`

const $ = {
  reset:  `${E}[0m`,
  bold:   `${E}[1m`,
  dim:    `${E}[2m`,
  green:  fg(0,   255, 136),
  dgreen: fg(0,   140, 75),
  dgreenb:fg(0,   60,  35),
  gray:   fg(55,  60,  65),
  dgray:  fg(28,  32,  36),
  white:  fg(195, 200, 210),
  dwhite: fg(90,  95,  108),
  yellow: fg(255, 210, 55),
  red:    fg(255, 80,  80),
  dred:   fg(120, 40,  40),
  indigo: fg(140, 130, 255),
  amber:  fg(245, 158, 11),
  bgDark: bg(4,   6,   8),
  bgNode: bg(0,   22,  14),
  bgRej:  bg(30,  8,   8),
}

// ── Layout ────────────────────────────────────────────────────────────────────

const W   = () => process.stdout.columns || 120
const H   = () => process.stdout.rows    || 36
const MID = () => Math.floor(W() * 0.42)

// Fixed row zones (1-indexed)
const ROW_HEADER_TOP  = 1
const ROW_HEADER_BOT  = 3
const ROW_TOP_START   = 4
const ROW_TOP_END     = () => Math.min(11, Math.floor(H() * 0.33))
const ROW_MID_DIV     = () => ROW_TOP_END() + 1
const ROW_BOT_START   = () => ROW_MID_DIV() + 1
const ROW_LOG         = () => H() - 2
const ROW_STATUS      = () => H() - 1
const ROW_FOOTER      = () => H()

// Payment flow node positions (right panel, row-relative to ROW_BOT_START)
const FLOW_COL        = () => MID() + 4
const FLOW_NODE_W     = 14
const FLOW_NODE_H     = 3
const FLOW_WIRE_H     = 1
const FLOW_STEP       = FLOW_NODE_H + FLOW_WIRE_H  // 4 rows per node+wire

// Node absolute rows
const nodeRow = (n: number) => ROW_BOT_START() + 1 + n * FLOW_STEP

// ── Static mock data ──────────────────────────────────────────────────────────

const AGENTS = [
  { name: "swap-agent",    scope: "[swap,read]",  status: "ACTIVE",   sc: $.green  },
  { name: "monitor-agent", scope: "[read]",        status: "WATCHING", sc: $.yellow },
  { name: "yield-agent",   scope: "[yield,swap]",  status: "PENDING",  sc: $.amber  },
]

const QUEUE = [
  { icon: "[!]", agent: "swap-agent",    action: "execute uniswap swap",  risk: "HIGH", approval: true  },
  { icon: "[ ]", agent: "monitor-agent", action: "fetch price feed",       risk: "LOW",  approval: false },
]

const AUDIT = [
  { time: "14:04", agent: "swap-agent",    event: "✓ quote fetched  0.0412 ETH",  ok: "ok"   },
  { time: "14:03", agent: "yield-agent",   event: "→ strategy selected kamino",   ok: "info" },
  { time: "14:02", agent: "swap-agent",    event: "✓ policy approved risk=LOW",   ok: "ok"   },
  { time: "14:01", agent: "monitor-agent", event: "→ subscribed to price feed",   ok: "info" },
  { time: "14:00", agent: "yield-agent",   event: "✗ rail unavailable retry=1",   ok: "err"  },
]

// ── Payment flow state ────────────────────────────────────────────────────────

type NS = "off" | "active" | "done" | "rejected"

interface FlowState {
  nodes:    [NS, NS, NS, NS]  // intent, policy, rails, execute
  rails:    { x402: NS; mpp: NS; gas: NS }
  step:     number
  log:      string[]
  autoPlay: boolean
  complete: boolean
  packet:   { nodeIdx: number; progress: number } | null
}

const FLOW_STEPS: Array<{
  log: string
  nodes: [NS, NS, NS, NS]
  rails: { x402: NS; mpp: NS; gas: NS }
  packet?: number  // which wire to animate (0=intent→policy, 1=policy→rails, 2=rails→execute)
}> = [
  {
    log:    "[14:02:31] INTENT    swap 100 USDC → ETH   intent=simple_swap   risk=LOW",
    nodes:  ["active", "off",    "off",    "off"],
    rails:  { x402: "off",    mpp: "off",      gas: "off" },
  },
  {
    log:    "[14:02:31] POLICY    ExecutionContext created   scope=[swap,read]   ttl=60m",
    nodes:  ["done", "active", "off",    "off"],
    rails:  { x402: "off",    mpp: "off",      gas: "off" },
    packet: 0,
  },
  {
    log:    "[14:02:32] POLICY    check PASSED   risk_tier=LOW   action=auto_execute",
    nodes:  ["done", "done",   "active", "off"],
    rails:  { x402: "active", mpp: "active",   gas: "active" },
    packet: 1,
  },
  {
    log:    "[14:02:32] RAILS     evaluated   x402=$0.001   MPP=$0.050   GAS=$0.002",
    nodes:  ["done", "done",   "active", "off"],
    rails:  { x402: "active", mpp: "rejected", gas: "rejected" },
  },
  {
    log:    "[14:02:33] RAILS     x402 selected — cheapest route   saving $0.049 vs MPP",
    nodes:  ["done", "done",   "done",   "active"],
    rails:  { x402: "done",   mpp: "rejected", gas: "rejected" },
    packet: 2,
  },
  {
    log:    "[14:02:33] EXECUTE   Uniswap v3   in=100 USDC   out=0.0412 ETH   tx=0x4a2f…9b1c  ✓",
    nodes:  ["done", "done",   "done",   "done"],
    rails:  { x402: "done",   mpp: "rejected", gas: "rejected" },
  },
]

const mkFlow = (): FlowState => ({
  nodes:    ["off", "off", "off", "off"],
  rails:    { x402: "off", mpp: "off", gas: "off" },
  step:     0,
  log:      [],
  autoPlay: false,
  complete: false,
  packet:   null,
})

let flow = mkFlow()

// ── Draw helpers ──────────────────────────────────────────────────────────────

function nodeStyle(ns: NS): string {
  if (ns === "active")   return $.bold + $.green + $.bgNode
  if (ns === "done")     return $.dgreen
  if (ns === "rejected") return $.dim + $.dred + $.bgRej
  return $.gray
}

function nodeBorder(ns: NS) {
  return ns === "active" ? { tl:"╔",tr:"╗",bl:"╚",br:"╝",h:"═",v:"║" }
                         : { tl:"┌",tr:"┐",bl:"└",br:"┘",h:"─",v:"│" }
}

function pad(s: string, n: number) {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length)
}

// Build entire frame as a string (prevents flicker vs multiple writes)
function buildFrame(): string {
  const w = W(), h = H(), mid = MID()
  let f = ""

  const put  = (r: number, c: number, s: string) => { f += at(r, c) + s }
  const hline = (r: number, c1: number, c2: number, col: string, ch: string) =>
    put(r, c1, col + ch.repeat(Math.max(0, c2 - c1)) + $.reset)
  const vline = (r1: number, r2: number, c: number, col: string) => {
    for (let r = r1; r <= r2; r++) put(r, c, col + "│" + $.reset)
  }

  // ── Header ────────────────────────────────────────────────────────────────
  put(ROW_HEADER_TOP, 1, $.bold + $.green + "╔" + "═".repeat(w - 2) + "╗" + $.reset)

  // header content row
  const now    = new Date().toLocaleTimeString("en-GB")
  const hLeft  = "  zhgg runtime"
  const hRight = `3 agents live  │  1 pending  │  x402 ACTIVE  │  ${now}  `
  const hPad   = " ".repeat(Math.max(0, w - hLeft.length - hRight.length - 2))
  put(2, 1, $.bold + $.green + "║" + $.reset)
  put(2, 2, $.bold + $.white + hLeft + $.reset + $.dwhite + hPad + hRight + $.reset)
  put(2, w, $.bold + $.green + "║" + $.reset)

  put(ROW_HEADER_BOT, 1, $.bold + $.green + "╠" + "═".repeat(mid - 1) + "╦" + "═".repeat(w - mid - 2) + "╣" + $.reset)

  // ── Top section titles ────────────────────────────────────────────────────
  const topEnd = ROW_TOP_END()
  put(ROW_TOP_START, 1, $.bold + $.green + "║" + $.reset)
  put(ROW_TOP_START, 2, $.dwhite + "  ACTIVE AGENTS" + $.reset)
  put(ROW_TOP_START, mid + 1, $.bold + $.green + "║" + $.reset)
  put(ROW_TOP_START, mid + 2, $.dwhite + "  ACTION QUEUE" + $.reset)
  put(ROW_TOP_START, w, $.bold + $.green + "║" + $.reset)

  // Agent rows
  AGENTS.forEach((a, i) => {
    const r  = ROW_TOP_START + 1 + i
    const sc = a.status === "ACTIVE" ? $.bold + $.green : a.status === "WATCHING" ? $.yellow : $.amber
    const dot = a.status === "ACTIVE" ? "●" : a.status === "WATCHING" ? "◎" : "○"
    if (r <= topEnd) {
      put(r, 1, $.green + "║" + $.reset)
      put(r, 3, sc + dot + " " + pad(a.name, 16) + " " + $.dwhite + pad(a.scope, 14) + " " + sc + a.status + $.reset)
      put(r, mid + 1, $.green + "║" + $.reset)
      put(r, w, $.green + "║" + $.reset)
    }
  })

  // Queue rows (right panel, top section)
  QUEUE.forEach((q, i) => {
    const r1 = ROW_TOP_START + 1 + i * 2
    const r2 = r1 + 1
    const rc = q.risk === "HIGH" ? $.red : $.green
    const ic = q.approval ? $.red : $.dwhite
    if (r1 <= topEnd) {
      put(r1, mid + 2, ic + "  " + q.icon + " " + $.white + q.agent + " → " + q.action + $.reset)
      put(r1, w, $.green + "║" + $.reset)
    }
    if (r2 <= topEnd) {
      put(r2, mid + 2, rc + "     risk=" + q.risk + (q.approval ? "  [A] approve  [D] deny" : "  ✓ auto") + $.reset)
      put(r2, w, $.green + "║" + $.reset)
    }
  })

  // Borders & side bars for top section rows
  for (let r = ROW_TOP_START + 1; r <= topEnd; r++) {
    put(r, 1, $.green + "║" + $.reset)
    put(r, mid + 1, $.dgray + "│" + $.reset)
    put(r, w, $.green + "║" + $.reset)
  }

  // ── Mid divider ───────────────────────────────────────────────────────────
  const midDiv = ROW_MID_DIV()
  put(midDiv, 1, $.green + "╠" + "─".repeat(mid - 1) + "╪" + "─".repeat(w - mid - 2) + "╣" + $.reset)

  // ── Bottom section titles ─────────────────────────────────────────────────
  const botStart = ROW_BOT_START()
  put(botStart, 1, $.green + "║" + $.reset)
  put(botStart, 2, $.dwhite + "  AUDIT TRAIL" + $.reset)
  put(botStart, mid + 1, $.green + "║" + $.reset)
  put(botStart, mid + 2, $.dwhite + "  PAYMENT FLOW" + $.reset)
  // Controls hint (right-aligned in header)
  const hint = "SPACE·A·R·Q  "
  put(botStart, w - hint.length, $.dgray + hint + $.reset)
  put(botStart, w, $.green + "║" + $.reset)

  // Audit trail
  const logEnd = ROW_LOG() - 1
  AUDIT.forEach((e, i) => {
    const r = botStart + 1 + i
    if (r > logEnd) return
    const ec = e.ok === "ok" ? $.dgreen : e.ok === "err" ? $.dred : $.dwhite
    put(r, 1, $.green + "║" + $.reset)
    put(r, 3, ec + e.time + " " + pad(e.agent, 15) + " " + e.event + $.reset)
  })

  // Side bars for bottom section
  for (let r = botStart + 1; r <= logEnd; r++) {
    put(r, 1, $.green + "║" + $.reset)
    put(r, mid + 1, $.dgray + "│" + $.reset)
    put(r, w, $.green + "║" + $.reset)
  }

  // ── Payment flow node diagram ─────────────────────────────────────────────
  const fc   = FLOW_COL()
  const nw   = FLOW_NODE_W
  const labels  = ["INTENT", "POLICY", "RAILS", "EXECUTE"]
  const nodeDesc = [
    ["swap USDC→ETH"],
    ["scope=[swap]"],
    ["eval rails"],
    ["uniswap v3"],
  ] as string[][]

  flow.nodes.forEach((ns, i) => {
    const nr   = nodeRow(i)
    const b    = nodeBorder(ns)
    const col  = nodeStyle(ns)
    const inner = nw - 2

    // Top border
    if (nr <= logEnd)
      put(nr, fc, col + b.tl + b.h.repeat(inner) + b.tr + $.reset)

    // Label row
    if (nr + 1 <= logEnd) {
      const label = pad(" " + labels[i]!, inner)
      put(nr + 1, fc, col + b.v + $.reset + col + label + $.reset + col + b.v + $.reset)
    }

    // Bottom border
    if (nr + 2 <= logEnd)
      put(nr + 2, fc, col + b.bl + b.h.repeat(inner) + b.br + $.reset)

    // Wire below (except last node)
    if (i < 3) {
      const wr = nr + 3
      if (wr <= logEnd) {
        const wireLit = ns === "done" || flow.nodes[i + 1] !== "off"
        const wc = wireLit ? $.dgreen : $.dgray
        const wireGlyph = wr === nr + 3 ? "│" : "▼"
        put(wr, fc + Math.floor(nw / 2) - 1, wc + wireGlyph + $.reset)
      }
    }

    // Rail labels beside RAILS node (index 2)
    if (i === 2) {
      const railCol = fc + nw + 2
      const rr = flow.rails
      const railLines = [
        { label: "x402 $0.001", ns: rr.x402, tag: " ◀" },
        { label: "MPP  $0.050", ns: rr.mpp,  tag: ""   },
        { label: "GAS  $0.002", ns: rr.gas,  tag: ""   },
      ]
      railLines.forEach(({ label, ns: rns, tag }, ri) => {
        const rrow = nr + ri
        if (rrow > logEnd) return
        const rc = rns === "active" || rns === "done" ? $.bold + $.green
                 : rns === "rejected"                 ? $.dim + $.dred
                 : $.dgray
        put(rrow, railCol, rc + label + (rns !== "off" ? tag : "") + $.reset)
      })
    }

    // ✓ beside EXECUTE when done
    if (i === 3 && ns === "done") {
      put(nr + 1, fc + nw + 1, $.bold + $.green + "✓ COMPLETE" + $.reset)
    }
  })

  // Packet animation
  if (flow.packet) {
    const { nodeIdx, progress } = flow.packet
    const wireCol = fc + Math.floor(nw / 2) - 1
    const startRow = nodeRow(nodeIdx) + 3
    const packetRow = startRow + Math.floor(progress)
    if (packetRow <= logEnd) {
      const glyphs = ["◉", "●", "◎"]
      const g = glyphs[Math.floor(Date.now() / 100) % 3]!
      put(packetRow, wireCol, $.bold + $.yellow + g + $.reset)
    }
  }

  // ── Log row ───────────────────────────────────────────────────────────────
  const logRow = ROW_LOG()
  put(logRow, 1, $.green + "╠" + "═".repeat(w - 2) + "╣" + $.reset)
  put(logRow + 1, 1, $.green + "║" + $.reset)
  const lastLog = flow.log[flow.log.length - 1] ?? "  Waiting — press SPACE or A to start the payment flow simulation"
  put(logRow + 1, 3, $.dwhite + lastLog.slice(0, w - 5) + $.reset)
  put(logRow + 1, w, $.green + "║" + $.reset)

  // ── Status / footer ───────────────────────────────────────────────────────
  const statusRow = ROW_STATUS()
  put(statusRow + 1, 1, $.green + "╠" + "═".repeat(w - 2) + "╣" + $.reset)

  const stepInfo  = flow.complete ? "COMPLETE" : `step ${flow.step}/${FLOW_STEPS.length}`
  const playInfo  = flow.autoPlay ? $.yellow + "◉ AUTO" + $.reset + $.dgray : $.dgray + "● MANUAL" + $.reset + $.dgray
  put(statusRow + 2, 1, $.green + "║" + $.reset)
  put(statusRow + 2, 3,
    $.dgray + "PAYMENT FLOW: " + playInfo + "  " + stepInfo +
    "    " + $.reset + $.dgray + "block 21,482,904  │  Ctrl+C exit" + $.reset)
  put(statusRow + 2, w, $.green + "║" + $.reset)
  put(h, 1, $.green + "╚" + "═".repeat(w - 2) + "╝" + $.reset)

  return f
}

// ── Render ────────────────────────────────────────────────────────────────────

let renderTimer: ReturnType<typeof setInterval> | null = null

function render() {
  const tooSmall = W() < 100 || H() < 28
  if (tooSmall) {
    process.stdout.write(`${E}[2J${E}[H` +
      $.red + "\n  Terminal too small — resize to at least 100×28\n" + $.reset)
    return
  }
  process.stdout.write(`${E}[?25l${E}[H` + buildFrame())
}

// ── Step logic ────────────────────────────────────────────────────────────────

let packetInterval: ReturnType<typeof setInterval> | null = null

function animatePacket(nodeIdx: number, done: () => void) {
  let progress = 0
  if (packetInterval) clearInterval(packetInterval)
  packetInterval = setInterval(() => {
    progress += 0.4
    if (progress >= 1) {
      clearInterval(packetInterval!)
      packetInterval = null
      flow.packet = null
      done()
      return
    }
    flow.packet = { nodeIdx, progress }
    render()
  }, 50)
}

function advance() {
  if (flow.complete || flow.step >= FLOW_STEPS.length) return
  const s = FLOW_STEPS[flow.step]!
  const prevPacket = s.packet

  flow.nodes    = [...s.nodes] as typeof flow.nodes
  flow.rails    = { ...s.rails }
  flow.log.push(s.log)
  flow.step++
  flow.complete = flow.step >= FLOW_STEPS.length

  render()

  if (prevPacket !== undefined) {
    animatePacket(prevPacket, () => render())
  }
}

// ── Auto-play ─────────────────────────────────────────────────────────────────

let autoTimer: ReturnType<typeof setInterval> | null = null

function setAuto(on: boolean) {
  flow.autoPlay = on
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null }
  if (on) {
    autoTimer = setInterval(() => {
      if (flow.complete) { setAuto(false); return }
      advance()
    }, 1800)
  }
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.setEncoding("utf8")

process.stdin.on("data", (key: string) => {
  if (key === "\x03" || key === "q" || key === "Q") {
    cleanup(); process.exit(0)
  }
  if (key === " " || key === "\r") {
    setAuto(false); advance()
  }
  if (key === "a" || key === "A") {
    setAuto(!flow.autoPlay); render()
  }
  if (key === "r" || key === "R") {
    setAuto(false)
    if (packetInterval) { clearInterval(packetInterval); packetInterval = null }
    flow = mkFlow(); render()
  }
})

// ── Cleanup ───────────────────────────────────────────────────────────────────

function cleanup() {
  if (autoTimer)    clearInterval(autoTimer)
  if (packetInterval) clearInterval(packetInterval)
  if (renderTimer)  clearInterval(renderTimer)
  process.stdout.write(`${E}[?25h${E}[2J${E}[H`)
}

process.on("exit",   cleanup)
process.on("SIGINT", () => { cleanup(); process.exit(0) })
process.stdout.on("resize", render)

// Refresh clock in header every second
renderTimer = setInterval(render, 1000)

// ── Start ─────────────────────────────────────────────────────────────────────

process.stdout.write(`${E}[2J`)
render()
