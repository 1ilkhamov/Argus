/**
 * ProfileSignal — typed intermediate model for the user profile inference pipeline.
 *
 * Pipeline: messages[] → ProfileSignal[] → resolveProfileFromSignals() → AgentUserProfilePatch
 *
 * Signals capture what was detected from the recent message window before
 * the most-recent-wins resolution is applied.
 */
import type { AgentPreferredLanguage, AgentTone, AgentUserProfile } from './user-profile.types';

/* ------------------------------------------------------------------ */
/*  Signal types                                                      */
/* ------------------------------------------------------------------ */

export type ProfileSignal =
  | { readonly dimension: 'language'; readonly value: AgentPreferredLanguage; readonly source: 'explicit_request' | 'character_vote' }
  | { readonly dimension: 'tone'; readonly value: AgentTone }
  | { readonly dimension: 'detail'; readonly value: AgentUserProfile['communication']['detail'] }
  | { readonly dimension: 'structure'; readonly value: AgentUserProfile['communication']['structure'] }
  | { readonly dimension: 'allow_pushback'; readonly value: boolean }
  | { readonly dimension: 'allow_proactive_suggestions'; readonly value: boolean };

export type ProfileSignalDimension = ProfileSignal['dimension'];

/* ------------------------------------------------------------------ */
/*  Signal helpers                                                    */
/* ------------------------------------------------------------------ */

export function firstSignalByDimension<D extends ProfileSignalDimension>(
  signals: readonly ProfileSignal[],
  dimension: D,
): Extract<ProfileSignal, { dimension: D }> | undefined {
  return signals.find((s): s is Extract<ProfileSignal, { dimension: D }> => s.dimension === dimension);
}
