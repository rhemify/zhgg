// Thin re-export: the demo's wiring is the canonical mock stack from @zhgg/router.
// Both this app and apps/tui consume `buildMockStack()` so a single source of
// truth controls provider lists, responder logic, and scope defaults.

export { buildMockStack as buildDemoStack, type MockStack as DemoStack } from '@zhgg/router';
