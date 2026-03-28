/**
 * DirectiveSignal — typed intermediate model for the response directives pipeline.
 *
 * Pipeline: text → DirectiveSignal[] → resolveFromSignals() → ResponseDirectives
 *
 * Signals capture what was detected before resolution and derived rules are applied.
 * This makes conflict resolution explicit, testable, and loggable.
 */
import type { AgentVerbosity } from '../core-contract';
import type { AgentStructurePreference, AgentTone } from '../profile/user-profile.types';
import type { ResponseDirectiveShape, ResponseSectionDirective } from './response-directives.types';

/* ------------------------------------------------------------------ */
/*  Signal types                                                      */
/* ------------------------------------------------------------------ */

export type DirectiveSignal =
  | { readonly dimension: 'language'; readonly value: 'ru' | 'en' }
  | { readonly dimension: 'tone'; readonly value: AgentTone }
  | { readonly dimension: 'verbosity'; readonly value: AgentVerbosity }
  | { readonly dimension: 'shape'; readonly value: Exclude<ResponseDirectiveShape, 'adaptive' | 'strict_sections'> }
  | { readonly dimension: 'structure'; readonly value: AgentStructurePreference }
  | { readonly dimension: 'single_sentence'; readonly value: true }
  | { readonly dimension: 'no_examples'; readonly value: true }
  | { readonly dimension: 'no_adjacent_facts'; readonly value: true }
  | { readonly dimension: 'uncertainty_first'; readonly value: true }
  | { readonly dimension: 'max_top_level_items'; readonly value: number }
  | { readonly dimension: 'exact_sections'; readonly value: ResponseSectionDirective[] };

export type DirectiveSignalDimension = DirectiveSignal['dimension'];

/* ------------------------------------------------------------------ */
/*  Signal helpers                                                    */
/* ------------------------------------------------------------------ */

export function firstSignalByDimension<D extends DirectiveSignalDimension>(
  signals: readonly DirectiveSignal[],
  dimension: D,
): Extract<DirectiveSignal, { dimension: D }> | undefined {
  return signals.find((s): s is Extract<DirectiveSignal, { dimension: D }> => s.dimension === dimension);
}

export function hasSignal(signals: readonly DirectiveSignal[], dimension: DirectiveSignalDimension): boolean {
  return signals.some((s) => s.dimension === dimension);
}
