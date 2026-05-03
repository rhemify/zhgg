import type { IntentCommand } from '../types.js';
import { resolveOracleTopic } from '../resolve.js';

export function parseAskOracle(parts: string[], trimmed: string): IntentCommand {
  const tail = parts.slice(2).join(' ').trim();
  if (tail.length === 0) {
    return { kind: 'unknown', raw: trimmed, reason: 'ask oracle needs a topic (eu-ai-act, mica, gdpr-ai, price, ETH/USD)' };
  }
  const topic = resolveOracleTopic(tail);
  if (!topic) {
    return { kind: 'unknown', raw: trimmed, reason: `unknown oracle topic "${tail}"` };
  }
  return { kind: 'ask-oracle', topic, raw: tail };
}
