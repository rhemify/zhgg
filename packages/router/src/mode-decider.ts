/// Mode decider — Phase 17.
///
/// Pure function: given the user-requested mode, the classifier's
/// recommendation, and the user's risk + override-policy preferences,
/// returns the mode the router should actually use. Stateless; testable
/// in isolation; emits no side effects.
///
/// Critical safety rules baked in:
///   1. Confidence < 0.7 → never override
///   2. CRITICAL-risk intents → never downgrade
///   3. Upgrade only when explicitly permitted
///   4. Downgrade only when explicitly permitted AND the prompt scores
///      ≤ 3 (so trivial-only — never silently weaken a "verified"
///      request just because the classifier thinks it's easy)

import type { Mode } from './intent.js';
import type { ClassifierResult } from './classifier.js';

/// Risk tier of the underlying intent. Maps to the four-tier system
/// described in CLAUDE.md (intent palace). Phase 14d's per-`permissionId`
/// scoping uses similar tiering for spend caps.
export type IntentRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface DecideOptions {
  /// User-requested mode (the original `intent.mode`).
  requested: Mode;
  /// What the classifier said. Pass `null` when the classifier was
  /// unavailable / not configured — decider returns `requested`
  /// unchanged.
  classified: ClassifierResult | null;
  /// Risk tier of the intent. CRITICAL intents are immune to
  /// downgrade regardless of classifier confidence.
  risk: IntentRisk;
  /// User policy: allow auto-upgrade (e.g. fast → consensus) when the
  /// classifier scores the prompt as harder than requested.
  allowUpgrade?: boolean;
  /// User policy: allow auto-downgrade (e.g. consensus → fast) for
  /// trivially simple prompts. OFF by default — we'd rather over-spend
  /// on a low-stakes intent than silently weaken a high-stakes one.
  allowDowngrade?: boolean;
}

/// Pure tier ordering: higher = more cost + more confidence.
const TIER: Record<Mode, number> = {
  fast: 0,
  verified: 1,
  consensus: 2,
  pipeline: 3,
};

const CONFIDENCE_THRESHOLD = 0.7;
const DOWNGRADE_MAX_SCORE = 3;

export interface DecideResult {
  mode: Mode;
  /// True when the decider chose a mode different from `requested`.
  overridden: boolean;
  /// One-liner explaining why. Goes to the `route.mode_overridden`
  /// telemetry event so audits can reconstruct the decision.
  reason: string;
}

export function decideMode(opts: DecideOptions): DecideResult {
  const { requested, classified, risk, allowUpgrade = true, allowDowngrade = false } = opts;

  // No classifier output → take the user's choice as-is.
  if (classified === null) {
    return { mode: requested, overridden: false, reason: 'classifier_unavailable' };
  }

  // Low-confidence classifier → take the user's choice as-is.
  if (classified.confidence < CONFIDENCE_THRESHOLD) {
    return {
      mode: requested,
      overridden: false,
      reason: `low_confidence (${classified.confidence.toFixed(2)} < ${CONFIDENCE_THRESHOLD})`,
    };
  }

  const requestedTier = TIER[requested];
  const recommendedTier = TIER[classified.recommended];

  // CRITICAL-risk intents: never downgrade. Upgrade is allowed only
  // when policy permits — but for CRITICAL we'd usually have
  // `allowUpgrade: true` anyway (better to over-spend than under-verify).
  if (risk === 'CRITICAL') {
    if (recommendedTier > requestedTier && allowUpgrade) {
      return {
        mode: classified.recommended,
        overridden: true,
        reason: `upgrade_critical (score=${classified.score})`,
      };
    }
    return { mode: requested, overridden: false, reason: 'no_change_critical' };
  }

  // Upgrade path: classifier wants higher tier.
  if (recommendedTier > requestedTier) {
    if (!allowUpgrade) {
      return { mode: requested, overridden: false, reason: 'upgrade_disallowed' };
    }
    return {
      mode: classified.recommended,
      overridden: true,
      reason: `upgrade (score=${classified.score})`,
    };
  }

  // Downgrade path: classifier wants lower tier.
  if (recommendedTier < requestedTier) {
    if (!allowDowngrade) {
      return { mode: requested, overridden: false, reason: 'downgrade_disallowed' };
    }
    if (classified.score > DOWNGRADE_MAX_SCORE) {
      return {
        mode: requested,
        overridden: false,
        reason: `downgrade_score_too_high (score=${classified.score} > ${DOWNGRADE_MAX_SCORE})`,
      };
    }
    return {
      mode: classified.recommended,
      overridden: true,
      reason: `downgrade (score=${classified.score})`,
    };
  }

  // Same tier — leave unchanged.
  return { mode: requested, overridden: false, reason: 'no_change' };
}
