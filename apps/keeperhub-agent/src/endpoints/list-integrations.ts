/// `GET /api/integrations` — list integrations bound to the org.
///
/// Each integration is a configured external connector (web3 wallet,
/// Discord webhook, Slack token, SendGrid, Resend, Safe, generic webhook,
/// ai-gateway). Workflows reference these by id, so listing them lets
/// the TUI surface "what can I plug into?" without leaving the runtime.
///
/// Empirically returns at least one entry by default — KH provisions a
/// `web3` integration on org creation pointing at the user's wallet
/// (the org-key's deployer). That entry's `name` is the wallet address
/// which is useful context for cross-referencing settle txs.

import type { KHClient } from '../client.js';
import type { KHResult } from '../index.js';

export type KHIntegrationType =
  | 'web3'
  | 'discord'
  | 'slack'
  | 'telegram'
  | 'sendgrid'
  | 'resend'
  | 'safe'
  | 'webhook'
  | 'ai-gateway'
  | string;

export interface KHIntegrationSummary {
  id: string;
  name: string;
  type: KHIntegrationType;
  /// True when KH manages credentials server-side (Turnkey-custodied
  /// wallets, KH-issued tokens). False for BYO integrations the user
  /// supplied keys for.
  isManaged?: boolean;
  createdAt?: string;
  updatedAt?: string;
  [extra: string]: unknown;
}

export async function listIntegrations(
  client: KHClient,
): Promise<KHResult<KHIntegrationSummary[]>> {
  const r = await client.get<unknown>('/api/integrations');
  if (!r.ok) return r;
  if (!Array.isArray(r.value)) {
    return {
      ok: false,
      error: {
        kind: 'malformed_response',
        reason: `expected array, got ${typeof r.value}`,
      },
    };
  }
  return { ok: true, value: r.value as KHIntegrationSummary[] };
}
