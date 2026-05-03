import { createFileRoute } from "@tanstack/react-router";
import { ExecutionMesh } from "../components/ExecutionMesh";


export const Route = createFileRoute("/")({
  component: HomeComponent,
});

// ── Data ──────────────────────────────────────────────────────────────────────

const SECTIONS = [
  {
    num: "01",
    key: "INTENT",
    question: "What does the user want to do?",
    description:
      "Every agent action begins as an intent. The zhgg taxonomy maps 45+ Ethereum web3 actions across four tiers — from a simple token swap to a multi-protocol compound strategy — each with a fully specced param schema, risk tier, and routing instruction.",
    bullets: [
      "45+ intent classes across 4 tiers",
      "Structured param extraction schema",
      "Risk tier: LOW → CRITICAL",
      "Protocol routing map per intent",
    ],
    accent: "#00ff88",
    dim: "rgba(0,255,136,0.06)",
  },
  {
    num: "02",
    key: "RAILS",
    question: "What payment protocol rails are needed?",
    description:
      "The runtime selects the right payment rail per action transparently. x402 handles crypto micropayments for data feeds and agent services. MPP provides web2 billing rails for retail users. Onchain gas covers chain execution — all three unified behind a single SDK call.",
    bullets: [
      "x402 crypto micropayments",
      "MPP web2 payment rails",
      "Onchain gas abstraction",
      "Auto rail selection per intent",
    ],
    accent: "#818cf8",
    dim: "rgba(129,140,248,0.06)",
  },
  {
    num: "03",
    key: "EXECUTE",
    question: "Where should execution occur?",
    description:
      "Execution flows through a policy-enforced MCP tool layer. Agents route to Uniswap, Aave, Lido, ENS, and more with scoped permissions that only narrow as they pass down the chain. Every action is passkey-signed and appended to a tamper-evident audit trail.",
    bullets: [
      "MCP tool layer (Uniswap, Aave, Lido, ENS)",
      "Policy enforced at call time",
      "Passkey-bound signing",
      "Signed, append-only audit trail",
    ],
    accent: "#f59e0b",
    dim: "rgba(245,158,11,0.06)",
  },
] as const;

const FEATURES = [
  {
    title: "ExecutionContext",
    desc: "Every agent run gets a scoped context bound to a passkey principal with a TTL. Agents never touch credentials directly.",
  },
  {
    title: "Policy Engine",
    desc: "OPA-style rules evaluated at the tool call layer — not spawn time. Prompt injection cannot bypass it.",
  },
  {
    title: "Attenuation",
    desc: "Sub-agents can only narrow scope, never expand it. Enforced by the SDK, not the LLM's judgment.",
  },
  {
    title: "Intent Taxonomy",
    desc: "45+ intent classes with param schemas, risk tiers, and protocol rails. Makes routing deterministic.",
  },
  {
    title: "Payment Abstraction",
    desc: "x402, MPP, and onchain gas behind one SDK call. The runtime picks the right rail per action.",
  },
  {
    title: "Audit Trail",
    desc: "Every action signed and logged in a forensically useful way — not just an append-only log file.",
  },
] as const;

const PROTOCOLS = ["Uniswap v3/v4", "Aave v3", "Lido", "ENS", "Compound", "Morpho", "Blur", "OpenSea"];

// ── Component ─────────────────────────────────────────────────────────────────

function HomeComponent() {
  return (
    <div
      className="min-h-screen bg-black text-zinc-100 font-mono overflow-x-hidden"
      style={{ colorScheme: "dark" }}
    >
      {/* ── Nav ── */}
      <nav className="fixed top-0 inset-x-0 z-50 border-b border-zinc-900 bg-black/70 backdrop-blur-md px-8 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-[#00ff88] font-bold text-base tracking-tight">zhgg</span>
          <span className="hidden sm:block text-zinc-700 text-[10px] border-l border-zinc-800 pl-3 uppercase tracking-widest">
            agent execution runtime
          </span>
        </div>
        <div className="flex items-center gap-6">
          {SECTIONS.map((s) => (
            <span
              key={s.key}
              className="text-[11px] text-zinc-600 uppercase tracking-widest cursor-default select-none"
            >
              {s.key}
            </span>
          ))}
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="relative h-screen flex items-center justify-center overflow-hidden">
        <ExecutionMesh className="absolute inset-0 w-full h-full" />

        {/* Radial vignette so text is legible over the canvas */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse 70% 60% at 50% 50%, transparent 0%, black 75%)",
          }}
        />
        {/* Bottom fade */}
        <div className="absolute bottom-0 inset-x-0 h-48 bg-gradient-to-t from-black to-transparent pointer-events-none" />

        <div className="relative z-10 text-center px-8 max-w-2xl">
          <p className="text-[10px] text-zinc-600 uppercase tracking-[0.4em] mb-6">
            ETHGlobal · OpenAgents
          </p>

          <h1 className="text-[clamp(4rem,12vw,8rem)] font-bold leading-none tracking-tighter text-white mb-6">
            zhgg
          </h1>

          <p className="text-lg text-zinc-400 leading-relaxed mb-4">
            The execution layer for onchain agents.
          </p>
          <p className="text-sm text-zinc-600 leading-relaxed mb-12 max-w-lg mx-auto">
            A TypeScript SDK that gives agents scoped permissions,
            policy-guarded tool execution, and unified payment rails — so they
            can act on behalf of users safely and verifiably on Ethereum.
          </p>

          {/* Pipeline pill */}
          <div className="inline-flex items-center gap-0 border border-zinc-800 rounded-sm overflow-hidden text-[10px] uppercase tracking-widest">
            {(["Intent", "Rails", "Execute"] as const).map((label, i) => {
              const colors = ["#00ff88", "#818cf8", "#f59e0b"] as const;
              return (
                <span key={label} className="flex items-center">
                  <span
                    className="px-4 py-2"
                    style={{ color: colors[i], background: `${colors[i]}08` }}
                  >
                    {label}
                  </span>
                  {i < 2 && (
                    <span className="px-2 text-zinc-700 bg-black">→</span>
                  )}
                </span>
              );
            })}
          </div>
        </div>

        {/* Scroll hint */}
        <div className="absolute bottom-8 inset-x-0 flex justify-center">
          <div className="flex flex-col items-center gap-2 text-zinc-700">
            <span className="text-[9px] uppercase tracking-[0.3em]">Scroll</span>
            <div className="w-px h-8 bg-gradient-to-b from-zinc-700 to-transparent" />
          </div>
        </div>
      </section>

      {/* ── Three Sections ── */}
      <section className="relative py-32 px-6 md:px-12">
        {/* Faint grid background */}
        <div
          className="absolute inset-0 opacity-[0.03] pointer-events-none"
          style={{
            backgroundImage:
              "linear-gradient(#00ff88 1px,transparent 1px),linear-gradient(90deg,#00ff88 1px,transparent 1px)",
            backgroundSize: "64px 64px",
          }}
        />

        <div className="relative max-w-7xl mx-auto">
          <div className="text-center mb-20">
            <p className="text-[10px] text-zinc-700 uppercase tracking-[0.4em] mb-3">
              How it works
            </p>
            <h2 className="text-3xl md:text-4xl font-bold text-white">
              Three primitives. One runtime.
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-zinc-900">
            {SECTIONS.map(({ num, key, question, description, bullets, accent, dim }) => (
              <div key={key} className="relative p-10 md:p-12 group">
                {/* Top accent bar */}
                <div
                  className="absolute top-0 left-0 right-0 h-[2px]"
                  style={{ background: accent }}
                />
                {/* Subtle top glow */}
                <div
                  className="absolute top-0 left-0 right-0 h-32 pointer-events-none"
                  style={{ background: `linear-gradient(to bottom, ${dim}, transparent)` }}
                />

                <div className="relative">
                  {/* Section number */}
                  <p
                    className="text-[10px] tracking-[0.4em] mb-8"
                    style={{ color: accent, opacity: 0.5 }}
                  >
                    {num}
                  </p>

                  {/* Key */}
                  <h3
                    className="text-3xl font-bold mb-4 tracking-tight"
                    style={{ color: accent }}
                  >
                    {key}
                  </h3>

                  {/* Question — italic, dim */}
                  <p className="text-xs text-zinc-600 italic mb-8 leading-relaxed">
                    {question}
                  </p>

                  {/* Description */}
                  <p className="text-sm text-zinc-400 leading-relaxed mb-10">
                    {description}
                  </p>

                  {/* Bullets */}
                  <ul className="space-y-3">
                    {bullets.map((b) => (
                      <li key={b} className="flex items-start gap-3 text-xs text-zinc-600">
                        <span
                          className="mt-[3px] shrink-0 text-[6px]"
                          style={{ color: accent }}
                        >
                          ◆
                        </span>
                        {b}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="py-24 px-6 md:px-12 border-t border-zinc-900">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <p className="text-[10px] text-zinc-700 uppercase tracking-[0.4em] mb-3">
              Core primitives
            </p>
            <h2 className="text-3xl font-bold text-white">Built for production agents.</h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-zinc-900">
            {FEATURES.map(({ title, desc }) => (
              <div key={title} className="bg-black p-8">
                <div className="flex items-center gap-3 mb-4">
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-[#00ff88] shrink-0"
                    style={{ boxShadow: "0 0 6px #00ff88" }}
                  />
                  <h4 className="text-sm font-bold text-zinc-200">{title}</h4>
                </div>
                <p className="text-xs text-zinc-600 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Protocol strip ── */}
      <section className="py-12 px-6 border-t border-zinc-900">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
          <span className="text-[9px] text-zinc-700 uppercase tracking-[0.4em] mr-4">
            Integrates with
          </span>
          {PROTOCOLS.map((p) => (
            <span key={p} className="text-[11px] text-zinc-600 cursor-default select-none">
              {p}
            </span>
          ))}
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-zinc-900 px-8 py-6 flex flex-wrap items-center justify-between gap-4 text-[10px] text-zinc-700">
        <span>zhgg · ETHGlobal OpenAgents 2026</span>
        <div className="flex items-center gap-6">
          {["x402", "MPP", "MCP", "Gensyn AXL", "EIP-7702"].map((t) => (
            <span key={t} className="uppercase tracking-widest">
              {t}
            </span>
          ))}
        </div>
      </footer>
    </div>
  );
}
