/// Standalone-mode MCP server entry. Run via `bun run src/standalone.ts`.
///
/// Why this file exists: the 0g-tee-inference plugin folder uses
/// path-mapped `@/lib/*` imports that resolve only via this package's
/// tsconfig. Library consumers of `@zhgg/workflow` shouldn't have to
/// inherit those mappings, so plugin imports stay isolated here.

import { plugin as zgPlugin } from '../plugins/0g-tee-inference/index.js';
import { buildRegistry, listTools } from './registry.js';
import { createHttpHandler } from './mcp-server.js';

if (import.meta.main) {
  const port = Number(process.env.MCP_PORT ?? 7743);
  const authToken = process.env.MCP_AUTH_TOKEN;
  if (!authToken) {
    console.error('MCP_AUTH_TOKEN env var is required for /call');
    process.exit(1);
  }

  const registry = buildRegistry([zgPlugin]);
  const tools = listTools(registry);
  const handler = createHttpHandler({ registry, authToken });

  Bun.serve({ port, fetch: handler });
  console.log(`zhgg-workflow MCP server listening on :${port}`);
  console.log(`  tools: ${tools.map((t) => t.name).join(', ')}`);
}
