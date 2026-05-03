/// KeeperHub marketplace x402 client — wraps `@keeperhub/wallet`.
///
/// `signer.fetch(url, init)` handles the canonical 402 round-trip:
///   1. POST to `/api/mcp/workflows/<slug>/call`
///   2. Receive 402 + paymentRequirements
///   3. KH server signs EIP-3009 via Turnkey (the wallet's HMAC secret
///      authenticates to KH's `/api/agentic-wallet/sign`)
///   4. Caller retries with PAYMENT-SIGNATURE header
///   5. Facilitator settles on Base USDC (30% to KH, 70% to author)
///   6. Workflow runs, returns response
///
/// Reality check: `WalletConfig.hmacSecret` is NOT an EVM private key —
/// it's an HMAC for KH's signing service. The actual ECDSA key lives in
/// Turnkey's sub-org and never leaves their custody. This means the 70%
/// arrives at `walletAddress` but we CANNOT sign FeeSplitter txs from
/// that wallet without integrating `@turnkey/viem` and obtaining the
/// sub-org's API key (which `@keeperhub/wallet` does not expose).
///
/// V1 hackathon design: this module returns the marketplace settlement
/// tx hash. The 85/5/5/5 sub-split on the 70% is a separate, manual step
/// — the iNFT owner triggers FeeSplitter from a normal viem wallet after
/// the marketplace settles.
///
/// V2 path (post-hackathon): wrap the receiving wallet as a smart contract
/// with a public `splitMyBalance()` function anyone can call to fan out
/// via FeeSplitter — removes the Turnkey-signs-FeeSplitter problem.

import { createPaymentSigner, KeeperHubClient, type WalletConfig } from '@keeperhub/wallet';
import type { Address, Hex } from 'viem';

export interface KeeperHubMarketplaceConfig {
  /// Turnkey sub-org id minted by `POST /api/agentic-wallet/provision`
  /// or `npx @keeperhub/wallet add` on the CLI.
  subOrgId: string;
  /// Author wallet address (Turnkey-custodied) — receives the 70% leg.
  walletAddress: Address;
  /// 64-char lowercase hex HMAC secret minted at provision time. NOT an
  /// EVM private key — only authenticates to KH's signing service.
  hmacSecret: string;
  /// Workflow slug (e.g. `mcp-test` for demo, `0g-tee-inference` for prod).
  marketplaceSlug: string;
  /// Override base URL — default `https://app.keeperhub.com`.
  baseUrl?: string;
}

export interface MarketplaceSettlement {
  /// Base Sepolia EIP-3009 settlement tx (KH-side, settled by facilitator).
  paymentTxHash: Hex;
  /// Wallet that signed the EIP-3009 (the caller, custodied by Turnkey).
  payerAddress: Address;
  /// CAIP-2 — `eip155:84532` for Base Sepolia.
  network: string;
  /// Raw workflow JSON body (the oracle response payload).
  marketplaceResponse: unknown;
}

/// Run a `/api/mcp/workflows/<slug>/call` x402 round-trip via the
/// official `@keeperhub/wallet` client. Returns the marketplace tx hash
/// + the workflow's JSON body.
export async function payViaKeeperHubMarketplace(
  cfg: KeeperHubMarketplaceConfig,
  requestBody: Record<string, unknown>
): Promise<MarketplaceSettlement> {
  const wallet: WalletConfig = {
    subOrgId: cfg.subOrgId,
    walletAddress: cfg.walletAddress,
    hmacSecret: cfg.hmacSecret,
  };

  // Normalise baseUrl: treat empty string the same as unset.
  // KEEPERHUB_API_URL="" in .env means process.env returns "" which the
  // ?? fallback does NOT catch (it only catches null/undefined). We fix
  // it here so KeeperHubClient never receives an empty baseUrl and tries
  // to construct relative URLs like /api/agentic-wallet/sign → "URL is invalid".
  const baseUrl = (cfg.baseUrl && cfg.baseUrl.length > 0)
    ? cfg.baseUrl
    : 'https://app.keeperhub.com';

  // Intercept fetch so we can log 402 headers — the payment challenge
  // lives in PAYMENT-REQUIRED (x402) or WWW-Authenticate (MPP). If those
  // are absent the signer bails and we need to see exactly what KH sent.
  const interceptFetch = (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
    const res = await globalThis.fetch(input, init);
    if (res.status === 402) {
      const hdrs: Record<string, string> = {};
      res.headers.forEach((v, k) => { hdrs[k] = v; });
      const body = await res.clone().text().catch(() => '<no body>');
      console.warn('[kh-x402] 402 response headers:', JSON.stringify(hdrs));
      console.warn('[kh-x402] 402 response body:', body);
    }
    return res;
  }) as typeof fetch;

  // Inject the wallet via walletLoader + clientFactory so we don't touch
  // ~/.keeperhub/wallet.json and KeeperHubClient uses our resolved baseUrl.
  const signer = createPaymentSigner({
    walletLoader: async () => wallet,
    clientFactory: (w) => new KeeperHubClient(w, { baseUrl }),
    fetchImpl: interceptFetch,
  });
  const resourceUrl = `${baseUrl.replace(/\/$/, '')}/api/mcp/workflows/${encodeURIComponent(cfg.marketplaceSlug)}/call`;

  // Validate URL before calling signer.fetch — a bad slug surfaces a
  // clear error rather than a cryptic "URL is invalid" from the fetch runtime.
  try { new URL(resourceUrl); } catch {
    throw new Error(`KH marketplace: invalid slug "${cfg.marketplaceSlug}" produces malformed URL: ${resourceUrl}`);
  }

  const res: Response = await signer.fetch(resourceUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    // Include key headers in the error so the operator can diagnose x402 issues.
    const paymentHdr = res.headers.get('payment-required') ?? res.headers.get('www-authenticate') ?? '(none)';
    throw new Error(`KH marketplace call failed: HTTP ${res.status} — ${text} | payment-hdr: ${paymentHdr}`);
  }

  const paymentTxHash = extractSettlementTx(res);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const fallbackHash =
    typeof body.paymentTxHash === 'string'
      ? (body.paymentTxHash as Hex)
      : ('0x0000000000000000000000000000000000000000000000000000000000000000' as Hex);

  return {
    paymentTxHash: paymentTxHash ?? fallbackHash,
    payerAddress: cfg.walletAddress,
    network: 'eip155:84532',
    marketplaceResponse: body,
  };
}

/// Extract the on-chain settlement tx hash from the `X-PAYMENT-RESPONSE`
/// header (x402 v2 convention — base64-encoded JSON with `transaction`
/// or `txHash` field). Returns `null` if header is absent or unparseable;
/// caller should fall back to the response body's `paymentTxHash` field.
function extractSettlementTx(res: Response): Hex | null {
  const hdr = res.headers.get('X-PAYMENT-RESPONSE');
  if (!hdr) return null;
  try {
    const decoded = JSON.parse(Buffer.from(hdr, 'base64').toString('utf-8')) as {
      transaction?: Hex;
      txHash?: Hex;
    };
    return decoded.transaction ?? decoded.txHash ?? null;
  } catch {
    return null;
  }
}
