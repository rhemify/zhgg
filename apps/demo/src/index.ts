import { runHeadlines, type HeadlineResult } from './agent.js';
import { runAuditCli } from './cross-agent-cli.js';
import { HEADLINES } from './headlines.js';
import { buildDemoStack } from './wire.js';

const PER_CALL_BUDGET_USD = 0.005;

function fmtUsd(n: number): string {
  return '$' + n.toFixed(6);
}

function fmtMs(n: number): string {
  return `${Math.round(n)}ms`;
}

function fmtHash(h: string | null): string {
  if (h === null) return '—';
  if (h.length <= 12) return h;
  return `${h.slice(0, 8)}…${h.slice(-4)}`;
}

function printResult(index: number, r: HeadlineResult): void {
  const num = `[${index + 1}]`;
  if (!r.ok) {
    console.log(`${num} ✗ ${r.headline}`);
    console.log(`     reason: ${r.reason}`);
    console.log(`     error:  ${r.error}`);
    console.log('');
    return;
  }
  const route = r.route!;
  console.log(`${num} ${r.headline}`);
  console.log(`     mode:        ${route.mode}  (${r.reason})`);
  console.log(`     response:    ${route.response}`);
  console.log(`     providers:   ${route.provider_ids.join(', ')}`);
  console.log(`     cost:        ${fmtUsd(route.cost_usd)}`);
  console.log(`     latency:     ${fmtMs(route.latency_ms)}`);
  if (route.attestation_root !== null) {
    console.log(`     attestation: ${fmtHash(route.attestation_root)}`);
  }
  if (route.agreement_score !== null) {
    const flag = route.low_confidence ? '  ⚠ low confidence' : '';
    console.log(`     agreement:   ${(route.agreement_score * 100).toFixed(0)}%${flag}`);
  }
  if (route.audit_cid !== null) {
    console.log(`     audit_cid:   ${fmtHash(route.audit_cid)}`);
  }
  console.log('');
}

function printSummary(results: readonly HeadlineResult[], settlements: number): void {
  const ok = results.filter((r) => r.ok);
  const totalCost = ok.reduce((s, r) => s + (r.route?.cost_usd ?? 0), 0);
  const fastCount = ok.filter((r) => r.route?.mode === 'fast').length;
  const consensusCount = ok.filter((r) => r.route?.mode === 'consensus').length;
  const lowConfCount = ok.filter((r) => r.route?.low_confidence === true).length;
  const ruler = '━'.repeat(60);
  console.log(ruler);
  console.log(
    `  ${ok.length}/${results.length} succeeded  |  total cost: ${fmtUsd(totalCost)}`,
  );
  console.log(
    `  ${settlements} settlements (${fastCount} fast × 1 + ${consensusCount} consensus × 3)`,
  );
  if (lowConfCount > 0) {
    console.log(`  ⚠ ${lowConfCount} call(s) flagged low confidence`);
  }
  console.log(ruler);
}

async function main(): Promise<void> {
  const ruler = '━'.repeat(60);
  console.log(ruler);
  console.log('  zhgg demo — trust-level inference router');
  console.log(`  agent iNFT #1  |  ${HEADLINES.length} headlines  |  MODE: mock`);
  console.log('  (no testnet calls; production wires real keeper + 0G Storage)');
  console.log(ruler);
  console.log('');

  const stack = buildDemoStack();
  let settlementCount = 0;
  stack.router.events.on('route.settlement_complete', () => {
    settlementCount += 1;
  });

  // Flush after each headline so audit_cid is populated before we print.
  // The audit callback mutates RouteResult.audit_cid synchronously inside
  // flush(), so awaiting it guarantees the field is non-null on success.
  const results = await runHeadlines(
    stack.router,
    stack.scope,
    HEADLINES,
    PER_CALL_BUDGET_USD,
    async (i, r) => {
      await stack.audit.flush();
      printResult(i, r);
    },
  );

  await stack.audit.close();

  printSummary(results, settlementCount);

  const failed = results.filter((r) => !r.ok).length;
  process.exit(failed > 0 ? 1 : 0);
}

async function entry(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === 'audit') {
    const target = args[1] ?? 'oracle.zhgg.eth';
    const code = await runAuditCli(target);
    process.exit(code);
  }
  await main();
}

entry().catch((err: unknown) => {
  const reason = err instanceof Error ? err.message : String(err);
  console.error(`demo failed: ${reason}`);
  process.exit(1);
});
