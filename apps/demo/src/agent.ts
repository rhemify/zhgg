import type { RouteResult, Router, ExecutionScope, RouteError } from '@zhgg/router';
import type { Headline } from './headlines.js';

export interface HeadlineResult {
  headline: string;
  reason: string;
  ok: boolean;
  route?: RouteResult;
  error?: string;
}

/**
 * Process a single headline through the router. Wraps the route() call so
 * the caller doesn't have to switch on Result discriminated unions.
 */
export async function processHeadline(
  router: Router,
  scope: ExecutionScope,
  headline: Headline,
  perCallBudgetUsd: number,
): Promise<HeadlineResult> {
  const result = await router.route(
    {
      prompt: `Classify this crypto headline as bullish/bearish/neutral: "${headline.text}"`,
      mode: headline.intent.mode,
      output_type: headline.intent.output_type,
      max_cost_usd: perCallBudgetUsd,
      max_latency_ms: 5_000,
    },
    scope,
  );
  if (result.ok) {
    return {
      headline: headline.text,
      reason: headline.intent.reason,
      ok: true,
      route: result.value,
    };
  }
  return {
    headline: headline.text,
    reason: headline.intent.reason,
    ok: false,
    error: formatRouteError(result.error),
  };
}

function formatRouteError(error: RouteError): string {
  if (error.kind === 'policy') {
    return `policy: ${error.violations.map((v) => v.rule).join(', ')}`;
  }
  return `${error.kind}: ${error.reason}`;
}

/**
 * Process N headlines sequentially. Order matters because the demo prints
 * each result as it lands so the operator sees progress in real time.
 */
export async function runHeadlines(
  router: Router,
  scope: ExecutionScope,
  headlines: readonly Headline[],
  perCallBudgetUsd: number,
  onResult?: (index: number, result: HeadlineResult) => void | Promise<void>,
): Promise<HeadlineResult[]> {
  const results: HeadlineResult[] = [];
  for (let i = 0; i < headlines.length; i++) {
    const result = await processHeadline(router, scope, headlines[i]!, perCallBudgetUsd);
    results.push(result);
    if (onResult) await onResult(i, result);
  }
  return results;
}
