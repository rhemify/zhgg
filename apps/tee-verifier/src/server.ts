/// TEE verifier HTTP service — Phase 23.
///
/// Implements the `verifierUrl` POST contract that
/// `packages/workflow/src/tee-attestation.ts` STRICT mode hits:
///
///   POST /verify
///   Body: { intel_quote, signing_address, request_nonce? }
///   200:  { valid: bool, verdict?, attestedAddress?, measurements?, reason? }
///
/// Run with:  bun run src/server.ts
/// Default port 8787 (override via `PORT`).
///
/// This is a real Bun HTTP server — no stub. Caller wires
/// `verifierUrl: 'http://tee-verifier.zhgg.local:8787/verify'` into the
/// workflow and gets the structural verdict. Cert-chain checking is a
/// follow-up that lives behind a feature flag once we have real Intel
/// collateral cached.

import { verifyTdxQuote } from './verifier.js';

const PORT = Number(process.env.PORT ?? 8787);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, service: 'tee-verifier', mode: 'structural' });
    }

    if (req.method !== 'POST' || url.pathname !== '/verify') {
      return new Response('Not Found', { status: 404 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch (e) {
      return Response.json(
        { valid: false, reason: `bad_json: ${e instanceof Error ? e.message : String(e)}` },
        { status: 400 }
      );
    }

    if (typeof body !== 'object' || body === null) {
      return Response.json({ valid: false, reason: 'body_not_object' }, { status: 400 });
    }
    const r = body as Record<string, unknown>;
    const intel_quote = typeof r.intel_quote === 'string' ? r.intel_quote : '';
    const signing_address = typeof r.signing_address === 'string' ? r.signing_address : '';
    const signing_algo = typeof r.signing_algo === 'string' ? r.signing_algo : undefined;
    const request_nonce = typeof r.request_nonce === 'string' ? r.request_nonce : undefined;

    if (!intel_quote || !signing_address) {
      return Response.json(
        { valid: false, reason: 'missing_required_fields' },
        { status: 400 }
      );
    }

    const result = verifyTdxQuote({
      intel_quote,
      signing_address,
      signing_algo,
      request_nonce,
    });
    return Response.json(result);
  },
});

console.log(
  `[tee-verifier] listening on http://localhost:${server.port}/verify  (mode=structural)`
);
