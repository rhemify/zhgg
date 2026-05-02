/// `GET /agents` — KeeperHub marketplace listing.
///
/// Returns the static AGENTS descriptor unchanged. Auth is enforced by
/// `server.ts` BEFORE this handler fires, so the body is just JSON of
/// `AGENTS`. KH workflows poll this endpoint to discover available
/// agents and render the input form from `inputSchema`.

import { AGENTS } from '../input-schemas.js';

export function handleListAgents(): Response {
  return Response.json({ agents: AGENTS });
}
