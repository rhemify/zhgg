/// Shim for `@/lib/metrics/instrumentation/plugin` from KeeperHub's monorepo.
///
/// In their runtime, this attaches plugin/action metrics to the step's
/// execution span (latency histograms, error counters tagged by plugin).
/// Here, it passes through. The same step file runs under bun for unit
/// tests and inside KeeperHub for production observability.
///
/// Surface inferred from KeeperHub/keeperhub@9b53eff46c479e9e15d3dbf12bf68ba69228e5cc/plugins/CLAUDE.md
/// TODO: re-verify against staging before drop-in merge.

export interface PluginMetricsOptions {
  pluginName: string;
  actionName: string;
  executionId?: string;
}

export async function withPluginMetrics<T>(
  _opts: PluginMetricsOptions,
  fn: () => T | Promise<T>
): Promise<T> {
  return await fn();
}
