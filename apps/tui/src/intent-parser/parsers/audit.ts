import type { OracleTopic } from '@zhgg/oracle-data';
import type { IntentCommand } from '../types.js';
import { resolveTarget } from '../resolve.js';

const VALID_TOPICS: ReadonlySet<OracleTopic> = new Set<OracleTopic>(['eu-ai-act', 'mica', 'gdpr-ai', 'price']);

export function parseAudit(parts: string[], trimmed: string): IntentCommand {
  const target = parts[1]?.trim();
  if (!target) {
    return { kind: 'unknown', raw: trimmed, reason: 'audit needs a target (ens or tokenId)' };
  }
  const resolved = resolveTarget(target, trimmed);
  if (!resolved.ok) return resolved.cmd;

  // Optional topic: `audit 1 eu-ai-act` | `audit 1 mica` | `audit 1 gdpr-ai` | `audit 1 price`
  const topicArg = parts[2]?.trim().toLowerCase() as OracleTopic | undefined;
  const topic: OracleTopic = (topicArg && VALID_TOPICS.has(topicArg)) ? topicArg : 'eu-ai-act';

  return { kind: 'audit', target, tokenId: resolved.tokenId, topic };
}
