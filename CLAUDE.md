## Important notes:
- Use bun
- Use threejs fibre for 3D animation

## Frontend Optimization techniques:
when implementing any certain features, think about whether the following can be implemented:

# Bundle & cold load

- use custom version tailored to what i need, do lazy splits + modulepreload + inlined CSS
- middleware checks cookies for routing

# Prefetch

- login intent preloads routes + APIs before session resolves
- preload 7 critical APIs + preconnect WS
- hover prefetch for tickers, chat, agents, screener

# Caching

- SWR cache tiers (30s–1d) headers
- localStorage → React Query hydration (prices for example have 5min)
- Gemini context cache (30m KV)
- AI summaries + chart data cached/shared

# Streaming & parallelism

- real token streaming (no fake chunks)
- anti-buffering headers for ai chats
- parallel tool calls + batched prompts
- client side api batches over single endpoint

# Rendering

- lazy charts w/ reserved height (no layout shift)
- tab-level lazy loading
- memoized list items
- instant paint on cache hits
- extremely light weight DOM

# WebSocket

- single shared WS across app
- smart reconnect + visibility gating
- prefetch on connect

# Service Worker

- app shell precached
- NetworkFirst nav (3s timeout)
- fonts cached 30d, idle registration