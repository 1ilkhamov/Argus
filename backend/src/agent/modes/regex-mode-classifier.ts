import { Injectable } from '@nestjs/common';

import { DEFAULT_AGENT_MODE } from './mode-registry';
import { ModeClassifier, type ModeClassification } from './mode-classifier';
import type { AgentModeId } from './mode.types';

type ModeSignal = {
  pattern: RegExp;
  weight: number;
};

const MODE_TIE_PRIORITY: AgentModeId[] = ['operator', 'strategist', 'researcher', 'reflective', 'assistant'];

const MODE_SIGNALS: Record<AgentModeId, ModeSignal[]> = {
  assistant: [],
  operator: [
    { pattern: /\b(implement|fix|build|create|update|delete|remove|refactor|run|deploy|ship|patch)\b/i, weight: 2 },
    { pattern: /\b(check|verify|test)\b/i, weight: 1 },
    { pattern: /\b(step[- ]by[- ]step|checklist|execute|execution)\b/i, weight: 1 },
    { pattern: /(реализуй|исправь|добавь|удали|обнови|сделай|запусти|разверни)/i, weight: 2 },
    { pattern: /(пошагово|пошагов|по шагам|чеклист|проверь|проверить|тест|проверка)/i, weight: 1 },
  ],
  strategist: [
    { pattern: /\b(strategy|strategic|roadmap|priority|priorities|direction|trade[- ]?off|leverage|goal|vision)\b/i, weight: 2 },
    { pattern: /\b(plan|planning)\b/i, weight: 1 },
    { pattern: /\b(architecture|architectural)\b/i, weight: 2 },
    { pattern: /(стратег|стратегия|роадмап|приоритет|направлен|компромисс|цель|видение)/i, weight: 2 },
    { pattern: /архитектур/i, weight: 2 },
    { pattern: /план/i, weight: 1 },
  ],
  researcher: [
    { pattern: /\b(research|investigate|compare|analysis|analyze|hypothesis|evidence|alternatives?|benchmark|pros and cons)\b/i, weight: 2 },
    { pattern: /\b(how does)\b/i, weight: 1 },
    { pattern: /(изучи|исследуй|сравни|анализ|проанализируй|гипотез|доказательств|вариант)/i, weight: 2 },
  ],
  reflective: [
    { pattern: /\b(feel|feeling|stuck|doubt|confused|uncertain|motivation|anxious|burnout)\b/i, weight: 2 },
    { pattern: /\b(what should i do|i don't know what i want)\b/i, weight: 2 },
    { pattern: /(чувствую|застрял|сомнева|неуверен|мотивац|тревож|выгор|не знаю что делать|не понимаю)/i, weight: 2 },
  ],
};

@Injectable()
export class RegexModeClassifier extends ModeClassifier {
  classify(content: string): ModeClassification {
    const scoredModes = (Object.entries(MODE_SIGNALS) as Array<[AgentModeId, ModeSignal[]]>).map(
      ([mode, signals]) => ({
        mode,
        score: signals.reduce(
          (total, signal) => total + (signal.pattern.test(content) ? signal.weight : 0),
          0,
        ),
      }),
    );

    return scoredModes.reduce<ModeClassification>(
      (best, current) => {
        if (current.score > best.score) {
          return current;
        }

        if (
          current.score === best.score &&
          MODE_TIE_PRIORITY.indexOf(current.mode) < MODE_TIE_PRIORITY.indexOf(best.mode)
        ) {
          return current;
        }

        return best;
      },
      { mode: DEFAULT_AGENT_MODE, score: 0 },
    );
  }
}
