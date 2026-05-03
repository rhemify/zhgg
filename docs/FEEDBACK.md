# KeeperHub Integration Feedback

> Last verified: 2026-05-03 against branch `siewwin`

**Project**: zhgg — bidirectional agentic-commerce runtime built on 0G iNFTs + KeeperHub marketplace + EU AI Act audit evidence chain
**Hackathon**: ETHGlobal OpenAgents, April–May 2026
**Repo**: branch `siewwin`
**Org integration**: provisioned web3 wallet `0x21DB...1A92` (org id `mioubx4xhpktk5y3etj21`)
**Live probe results**: `tasks/integration-audit-final.md`, `tasks/partner-alignment.md` (gitignored — local working notes)

---

## TL;DR

- We built **bidirectional** integration: zhgg agents discover + hire KH workflows AND expose themselves as KH-callable workflows via an HTTP adapter.
- We probed your deployed bearer-API surface live and documented which endpoints are real vs aspirational (you have a doc/deploy gap; details below).
- We pivoted away from the unmaintained shim approach when probing showed a different architecture worked better — we now live entirely on the public bearer-auth API + x402 marketplace facilitator.
- Six of eight criteria from `tasks/partner-alignment.md` are ✓; two are ⚠ blocked on KH-side endpoints not yet deployed.

---

## What we built that integrates with KeeperHub

| # | Capability | File evidence | Commit |
|---|---|---|---|
| 1 | Real x402 marketplace consume (`kh hire <slug> [json]`) | `apps/demo/src/keeperhub-marketplace.ts:60-122` + `apps/tui/src/index.ts:dispatchKHHireIntent` | `bc0bc79` |
| 2 | Marketplace discovery (`kh discover [search]`) | `apps/keeperhub-agent/src/endpoints/discover.ts` (live: 27 MCP-callable workflows surfaced) | `712e9d4`, `4b4b468` |
| 3 | Workflow inspection (`kh inspect <wfId>`) | same file, surfaces full `inputSchema` + `priceUsdcPerCall` | `712e9d4` |
| 4 | Async workflow trigger + status polling | `apps/keeperhub-agent/src/endpoints/workflow-{trigger,status}.ts` | `74b37f8` |
| 5 | Org workflow + integration listing | `apps/keeperhub-agent/src/endpoints/list-{workflows,integrations}.ts` (your provisioned web3 wallet showed up clean) | `74b37f8`, `56195ae` |
| 6 | **Bidirectional** — KH workflows can hire OUR agents | `apps/zhgg-mcp-adapter/src/server.ts` exposes `audit/oracle/swap` over HTTP with bearer auth, KH-compatible `web3` integration target | `c1c5e66` |
| 7 | 4-way FeeSplitter (KH gets 5% on every settle) | `contracts/src/FeeSplitter.sol:42-44` — 85/5/5/5 split, KH treasury hardcoded as a first-class beneficiary | (D1) |
| 8 | EU AI Act audit evidence chain — every KH-paid audit produces a tamper-proof JSON anchored to 0G Storage + ERC-8004 | `packages/workflow/src/audit-report.ts`, `apps/zhgg-mcp-adapter/src/index.ts` route handler | `b4f0350`, `c1c5e66` |

---

## Live probe results — what's actually deployed for `kh_` bearer auth

We did a systematic probe of the documented bearer-API surface on `app.keeperhub.com` on 2026-05-02 with our `kh_` org token. **Documented vs deployed differ significantly.**

### ✅ Working endpoints (verified live)

| Endpoint | Returns | Notes |
|---|---|---|
| `GET /api/workflows` | empty array (org has none yet) | works |
| `GET /api/integrations` | one entry — the web3 wallet you auto-provisioned for our org | confirms server-side wallet binding |
| `GET /api/mcp/workflows` | 27 entries paginated 20/page | needs `?limit=100` to skip pagination |
| `GET /api/workflows/public` | 85 entries | broader public-readable set |
| `POST /api/workflow/{id}/execute` | 404 on bad id (real route exists) | works for owned workflows |
| `GET /api/workflows/executions/{id}/status` | 404 on bad id (real route exists) | works |
| `POST /api/mcp/workflows/<slug>/call` | x402 round-trip via `payViaKeeperHubMarketplace` | settlement leg works |

### ❌ Documented but NOT deployed for bearer auth

| Endpoint | Status | Documented in |
|---|---|---|
| `GET /api/analytics/spend-cap` | 401 Unauthorized (session-only?) | `docs/keeperhub-research/kh-api.md` |
| `GET /api/analytics/runs` | 401 / 404 | same |
| `GET /api/analytics/summary` | 401 | same |
| `GET /api/runs` | 404 | same |
| `GET /api/me`, `/api/orgs/{id}` | 404 | inferred |

We removed our `kh cap` and `kh runs` TUI intents in `56195ae` after this probe and replaced them with the working `kh discover` / `kh inspect` instead. Surfaced an honest "endpoint not deployed" message to operators who type the old commands.

**Actionable feedback**: either the docs need to be marked "session-only" for those endpoints, or the bearer-auth surface needs to land. The discrepancy ate ~2h of integration time before we probed our way out of it.

---

## What we'd want from KeeperHub next (concrete asks)

| Want | Rationale | We're ready when it lands |
|---|---|---|
| **Bearer-auth `POST /api/workflows` to publish** | Currently only the web UI can register a marketplace slug. We have the publishing wiring shaped (the MCP adapter's input schemas would map directly) but can't fire it. | `apps/zhgg-mcp-adapter/src/input-schemas.ts` already exposes the 3 agents in your marketplace shape |
| **Marketplace search by tag in the API** | Currently must fetch all 27 + filter client-side. Fine at this scale; breaks at 1000+. | trivial — drop the client-side filter |
| **Outbound webhook on workflow completion** | Inbound triggers only today. We poll `/api/analytics/runs` (when it works) or use the synchronous trigger response. | poller infrastructure already in `apps/keeperhub-agent/` |
| **`/api/me` + `/api/orgs/{id}`** | We need to display org context in the TUI ("you're publishing as <org-name>"). Currently parse it indirectly from the integrations list. | one-line UI hint |
| **Publish-from-CLI flow with `kh_` bearer** | Same ask as #1 from the workflow author side; would unlock our `kh publish` intent | `kh publish <agent>` parser arm + dispatcher are ready in our codebase pending the endpoint |

---

## Architectural note: shims vs adapters

Our earlier integration plan (April) attempted a "drop-in mergeable plugin" approach with shims for `@/lib/*` paths. We ditched that after the live probe revealed the bearer-API surface was the cleaner abstraction:

- **Shim approach pros**: tighter coupling to your internals; richer hooks
- **Shim approach cons**: requires KH to merge our PR; we can't iterate without you; couples our release schedule to yours
- **Adapter approach pros**: pure HTTP boundary; we ship independently; clean test surface
- **Adapter approach cons**: relies on stable bearer-API contract (which is partially undocumented today)

We'd happily contribute the shim if the architecture changes; for the hackathon timeline the adapter pattern shipped faster.

---

## Production-readiness signals

| Signal | Status |
|---|---|
| Real org integration confirmed | ✓ web3 wallet `0x21DB...1A92` returned by `/api/integrations` |
| Bearer auth never logged | ✓ `apps/keeperhub-agent/src/index.ts:159-169` validates env before clienting; reasons name only the env var, never the key value |
| Empty-string env handling | ✓ `apps/keeperhub-agent/src/index.ts:184` distinguishes `undefined` from `""` for `KEEPERHUB_API_URL` (caught a real bug — `??` lets `""` through and `fetch("/api/...")` rejects) |
| HTTP error pass-through | ✓ 4xx/5xx surface verbatim in `kh.<intent>.failed` audit rows; never wrapped in a synthetic success |
| Test coverage | 745 TS tests, 227 forge tests, 15/15 type-check across the workspace |
| MCP adapter `MCP_AUTH_TOKEN` refusal | ✓ refuses to start with no auth; `auth.ts` constant-time-ish compare; never echoes token in error responses |
| Bigint stringification on JSON boundaries | ✓ `apps/zhgg-mcp-adapter/src/routes/audit.ts:117` |

---

## Cross-promotion / use-case

zhgg agents can be hired BY KeeperHub workflows AND can hire KeeperHub workflows. The architecture turns KeeperHub from a workflow runner into a discoverable agent service mesh:

- A KH workflow needing AI compliance audit drops a `web3 → HTTP Action` node pointing at our `@zhgg/mcp-adapter` `/agents/audit/call` endpoint, pays $0.10 USDC via x402, and gets back a canonical EU AI Act AuditReport JSON anchored on 0G Storage + an ERC-8004 receipt.
- A zhgg agent needing a third-party data feed types `kh discover yield` in the TUI, picks "Stablecoin Yield Compare: USDC on Base" ($0.05/call), pays via x402, gets the response.

That's the marketplace flywheel — both directions work today.

---

## What we wish we'd known earlier

1. The `/api/mcp/workflows` page-size default is 20. Our first integration showed only the top 20 of 27 entries; took a probe to discover.
2. The `KEEPERHUB_API_URL` env in your `@keeperhub/wallet` package shouldn't accept empty string — it produces a malformed URL silently. We patched in our agent (`56195ae`).
3. Marketplace slugs are nullable on the workflow object; not every public workflow is callable. We surface this honestly (`apps/tui/src/kh-hire-validate.ts` refuses with "discoverable but not yet slug-callable").
4. The `payViaKeeperHubMarketplace` x402 path requires `KH_AUTHOR_*` env vars even on the buyer side (Turnkey-custodied wallet provisioning). The `@keeperhub/wallet` package readme could call this out — we hit a 4-line refusal path before realizing.

---

## Asks summary (priority-ordered)

1. **🔥 Land bearer-auth publish endpoint** — biggest unlock; we have a `kh publish` intent shaped and ready
2. **🟢 Document the `/api/analytics/*` session-vs-bearer split** — saves the next integrator 2h
3. **🟢 Marketplace search by tag** — nice-to-have at our scale
4. **🟡 Outbound completion webhook** — would replace polling

---

## Contact

Branch `siewwin` is the canonical state. Happy to walk through any specific integration choice. Our MCP adapter is portable — point your `web3` integration at our `/agents/{audit,oracle,swap}/call` endpoints with a bearer and it works.
