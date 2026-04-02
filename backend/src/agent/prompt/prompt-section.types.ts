export type PromptSectionPriority = 'critical' | 'high' | 'medium' | 'low';

export type PromptSectionTrimPolicy = 'never' | 'drop' | 'compress';

export interface SystemPromptSection {
  id: string;
  title: string;
  priority: PromptSectionPriority;
  trimPolicy: PromptSectionTrimPolicy;
  source: 'soul' | 'mode' | 'profile' | 'directive' | 'memory' | 'archive' | 'identity' | 'grounding' | 'tooling';
  content: string;
  estimatedTokens?: number;
}

export interface StructuredSystemPrompt {
  sections: SystemPromptSection[];
  content: string;
}
