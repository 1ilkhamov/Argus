import type { AgentVerbosity } from './core-contract';
import type {
  AgentPreferredLanguage,
  AgentStructurePreference,
  AgentTone,
} from './profile/user-profile.types';

export type ResponseDirectiveShape = 'adaptive' | 'definition_only' | 'steps_only' | 'strict_sections';

export interface ResponseSectionDirective {
  index: number;
  label: string;
}

export interface ResponseHardLimitDirectives {
  singleSentence?: boolean;
  noExamples?: boolean;
  noAdjacentFacts?: boolean;
  noOptionalExpansion?: boolean;
  maxTopLevelItems?: number;
  exactSections?: ResponseSectionDirective[];
  uncertaintyFirst?: boolean;
}

export interface ResponseDirectives {
  language?: Exclude<AgentPreferredLanguage, 'auto'>;
  tone?: AgentTone;
  verbosity?: AgentVerbosity;
  structure?: AgentStructurePreference;
  shape: ResponseDirectiveShape;
  hardLimits: ResponseHardLimitDirectives;
}

export const EMPTY_RESPONSE_DIRECTIVES: ResponseDirectives = {
  shape: 'adaptive',
  hardLimits: {},
};

export function hasExplicitResponseDirectives(directives: ResponseDirectives): boolean {
  return Boolean(
    directives.language ||
      directives.tone ||
      directives.verbosity ||
      directives.structure ||
      directives.shape !== 'adaptive' ||
      directives.hardLimits.singleSentence ||
      directives.hardLimits.noExamples ||
      directives.hardLimits.noAdjacentFacts ||
      directives.hardLimits.noOptionalExpansion ||
      directives.hardLimits.maxTopLevelItems !== undefined ||
      (directives.hardLimits.exactSections?.length ?? 0) > 0 ||
      directives.hardLimits.uncertaintyFirst,
  );
}

export function hasStrictResponseDirectives(directives: ResponseDirectives): boolean {
  return Boolean(
    directives.language ||
      directives.shape !== 'adaptive' ||
      directives.hardLimits.singleSentence ||
      directives.hardLimits.noExamples ||
      directives.hardLimits.noAdjacentFacts ||
      directives.hardLimits.noOptionalExpansion ||
      directives.hardLimits.maxTopLevelItems !== undefined ||
      (directives.hardLimits.exactSections?.length ?? 0) > 0 ||
      directives.hardLimits.uncertaintyFirst,
  );
}
