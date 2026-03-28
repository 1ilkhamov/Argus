import type { AgentModeId } from './mode.types';

export interface ModeClassification {
  mode: AgentModeId;
  score: number;
}

export abstract class ModeClassifier {
  abstract classify(content: string): ModeClassification;
}
