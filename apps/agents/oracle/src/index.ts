/// oracle.zhgg.eth — agent wrapper.
///
/// The actual data + queryOracle function live in `@zhgg/oracle-data`
/// (a leaf package — workflow plugins import from there too without
/// inverting the package layering). This file is a thin re-export so the
/// agent's external surface stays at `apps/agents/oracle` for symmetry
/// with `apps/agents/audit`. Future agent-specific behaviour (caching,
/// rate limiting, MCP self-registration) lands here without touching the
/// leaf data package.

export * from '@zhgg/oracle-data';
