import { Injectable, Logger, Optional } from '@nestjs/common';

import { LlmService } from '../../../llm/llm.service';
import type { LlmMessage } from '../../../llm/interfaces/llm.interface';
import type { IdentityCategory } from '../../../memory/core/memory-entry.types';
import { IDENTITY_CATEGORIES } from '../../../memory/core/memory-entry.types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExtractedIdentityTrait {
  category: IdentityCategory;
  content: string;
  confidence: 'high' | 'medium';
  signal: string; // what triggered the extraction (for debugging/audit)
}

export interface IdentityExtractionResult {
  traits: ExtractedIdentityTrait[];
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

const IDENTITY_EXTRACTION_PROMPT = `You are an identity signal detector for an AI assistant called Argus. Your job is to analyze a conversation turn and detect behavioral signals about how the assistant should adapt its personality for THIS specific user.

You are looking for SIGNALS — not facts. Facts about the user go to general memory. Identity traits describe how the AGENT should behave.

Signal categories:
1. **personality** — How the agent's character should manifest (e.g., "be more direct", "use humor", "be patient with explanations")
2. **style** — Communication style preferences (e.g., "skip preambles", "use analogies", "prefer bullet points over prose")
3. **expertise** — Areas where the agent performs well with this user and should lean into
4. **weakness** — Areas where the agent failed or frustrated the user
5. **relationship** — Relationship dynamics (e.g., "user trusts agent for architecture decisions", "user wants pushback on bad ideas")
6. **boundary** — Things the agent should NOT do (e.g., "don't apologize", "don't use emoji", "don't over-explain")
7. **value** — What to prioritize (e.g., "action over deliberation", "production quality over speed")

Signal sources (what to look for):
- **Explicit corrections**: user says "don't do X", "I prefer Y", "stop being Z"
- **Praise/positive feedback**: user says "great", "exactly what I needed", "this is perfect" → what made it good?
- **Frustration signals**: user repeats themselves, shortens messages, uses "...", says "no" or "не то"
- **Style preferences**: user consistently uses short messages → agent should be concise. User writes in detail → agent can be detailed.
- **Behavioral requests**: "будь конкретнее", "не разжёвывай", "реализовывать нужно мощно"

Rules:
- Only extract when there is a CLEAR signal. Most turns have ZERO identity traits. Return empty array for routine turns.
- Content must be actionable — describe HOW the agent should behave, not WHAT the user said.
- Write content in the same language the user uses.
- Confidence: "high" for explicit corrections/requests, "medium" for inferred signals.
- Signal field: brief quote or description of what triggered this extraction.
- Do NOT extract generic observations. "User asked about TypeScript" is NOT an identity trait.
- Do NOT repeat existing identity traits — only extract NEW signals.

Response format (strict JSON, no markdown):
{
  "traits": [
    {"category": "style", "content": "Skip introductory preambles and lead with the answer", "confidence": "high", "signal": "user said 'не разжёвывай'"},
    {"category": "boundary", "content": "Never start responses with filler affirmations like 'Great question!'", "confidence": "high", "signal": "user explicitly corrected this behavior"}
  ]
}

If no identity signals are detected, return: {"traits": []}`;

const MAX_IDENTITY_TOKENS = 800;
const IDENTITY_TEMPERATURE = 0.1;
const MAX_MESSAGE_CHARS = 2000;

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class IdentityExtractorService {
  private readonly logger = new Logger(IdentityExtractorService.name);

  constructor(@Optional() private readonly llmService?: LlmService) {}

  isAvailable(): boolean {
    return this.llmService !== undefined && this.llmService !== null;
  }

  /**
   * Analyze a conversation turn for identity signals.
   * Returns extracted traits or undefined if extraction is unavailable/fails.
   */
  async extractFromTurn(
    userMessage: string,
    assistantResponse: string,
  ): Promise<IdentityExtractionResult | undefined> {
    if (!this.isAvailable()) return undefined;
    if (!userMessage.trim()) return undefined;

    // Quick heuristic pre-filter: skip very short routine messages
    // that are unlikely to contain identity signals
    if (this.isRoutineTurn(userMessage)) {
      return { traits: [] };
    }

    const turnContent = this.buildTurnContent(userMessage, assistantResponse);

    const messages: LlmMessage[] = [
      { role: 'system', content: IDENTITY_EXTRACTION_PROMPT },
      { role: 'user', content: `Analyze this conversation turn for identity signals:\n\n${turnContent}` },
    ];

    try {
      const result = await this.llmService!.complete(messages, {
        maxTokens: MAX_IDENTITY_TOKENS,
        temperature: IDENTITY_TEMPERATURE,
      });

      return this.parseResult(result.content);
    } catch (error) {
      this.logger.warn(
        `Identity extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  // ─── Pre-filter heuristic ──────────────────────────────────────────────

  private isRoutineTurn(userMessage: string): boolean {
    const trimmed = userMessage.trim();

    // Very short messages like "ok", "да", "continue" — no signal
    if (trimmed.length < 10) return true;

    // Pure code or data pastes (no natural language signal)
    const codeBlockRatio = (trimmed.match(/```[\s\S]*?```/g) ?? [])
      .reduce((acc, block) => acc + block.length, 0) / trimmed.length;
    if (codeBlockRatio > 0.8) return true;

    return false;
  }

  // ─── Content building ─────────────────────────────────────────────────

  private buildTurnContent(userMessage: string, assistantResponse: string): string {
    const userPart = userMessage.slice(0, MAX_MESSAGE_CHARS);
    const assistantPart = assistantResponse.slice(0, MAX_MESSAGE_CHARS);
    return `USER:\n${userPart}\n\nASSISTANT:\n${assistantPart}`;
  }

  // ─── Parsing ──────────────────────────────────────────────────────────

  private parseResult(raw: string): IdentityExtractionResult | undefined {
    try {
      const cleaned = raw
        .replace(/```json?\s*/g, '')
        .replace(/```\s*/g, '')
        .trim();

      const parsed = JSON.parse(cleaned);
      if (!parsed || typeof parsed !== 'object') return undefined;

      const traits = this.validateTraits(parsed.traits);
      return { traits };
    } catch (error) {
      this.logger.warn(
        `Failed to parse identity extraction: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  private validateTraits(raw: unknown): ExtractedIdentityTrait[] {
    if (!Array.isArray(raw)) return [];

    const validCategories = new Set<string>(IDENTITY_CATEGORIES);
    const validConfidences = new Set(['high', 'medium']);

    return raw
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).category === 'string' &&
        validCategories.has((item as Record<string, unknown>).category as string) &&
        typeof (item as Record<string, unknown>).content === 'string' &&
        ((item as Record<string, unknown>).content as string).trim().length >= 5 &&
        typeof (item as Record<string, unknown>).signal === 'string',
      )
      .map((item) => ({
        category: item.category as IdentityCategory,
        content: (item.content as string).trim().slice(0, 300),
        confidence: validConfidences.has(item.confidence as string)
          ? (item.confidence as 'high' | 'medium')
          : 'medium',
        signal: (item.signal as string).trim().slice(0, 200),
      }))
      .slice(0, 5); // max 5 traits per turn (safety cap)
  }
}
