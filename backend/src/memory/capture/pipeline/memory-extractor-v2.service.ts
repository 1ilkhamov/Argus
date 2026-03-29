import { Injectable, Logger, Optional } from '@nestjs/common';

import { LlmService } from '../../../llm/llm.service';
import type { LlmMessage } from '../../../llm/interfaces/llm.interface';
import type { MemoryKind } from '../../core/memory-entry.types';

// ─── Extraction Result ──────────────────────────────────────────────────────

export interface ExtractedMemoryItem {
  kind: MemoryKind;
  content: string;
  category?: string;
  tags?: string[];
  importance?: number; // 0.0–1.0, LLM's assessment
}

export interface ExtractedInvalidation {
  contentPattern: string; // substring to match against existing entries
  kind?: MemoryKind;      // optionally scoped to a kind
  reason: string;
}

export interface MemoryExtractionResult {
  items: ExtractedMemoryItem[];
  invalidations: ExtractedInvalidation[];
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction engine for an AI assistant. Given the latest user message and assistant response from a conversation, extract information worth remembering.

Extract into these categories:

1. **fact** — A concrete fact about the user or their environment (name, role, project, stack, preferences, config values, etc.). Open-ended: any key-value-like fact.
2. **episode** — Something that happened: a decision, event, goal, constraint, background context, task.
3. **action** — Something the assistant DID (tool call, code generation, search, file edit). Include what was done and the result.
4. **learning** — A lesson or insight: what worked, what didn't, what to avoid, a conclusion.
5. **skill** — A capability the assistant demonstrated or the user confirmed (e.g., "can deploy to Netlify", "knows NestJS").
6. **preference** — A user preference about communication, workflow, or tools (e.g., "prefers Russian", "wants concise answers", "likes TypeScript").
7. **identity** — An observed trait about how the assistant should behave with THIS user, learned from interaction signals (corrections, praise, frustration, explicit style requests). Categories: personality, style, expertise, weakness, relationship, boundary, value. Only extract when there is clear signal — most turns have none.

Also extract **invalidations** — things the user explicitly says are no longer true or should be forgotten.

Rules:
- Only extract what is EXPLICITLY stated or clearly demonstrated. Do not infer.
- Content should be concise (under 200 chars) and preserve the user's wording when possible.
- Write extracted content in the same language the user is using in the current message.
- Set importance: 0.0 (trivial) to 1.0 (critical). Facts about identity = 0.8+. Temporary context = 0.3-0.5.
- Add relevant tags (1-3 words each, lowercase).
- Add category when clear (e.g., "identity", "technical", "workflow", "project", "communication").
- For invalidations, provide a substring pattern that matches the content of entries to invalidate. The pattern can be a single distinctive keyword (e.g., "NovaTech", "PostgreSQL") — it does not need to be a full sentence.
- When the user changes employer, project, role, email, location, timezone, or team composition, ALWAYS generate an invalidation for the old value even if the user does not explicitly say "forget X". For example, "I now work at CloudBase" implies the previous employer is outdated; "Timezone теперь UTC+3" implies the old timezone is outdated.
- When the user CORRECTS or ROLLS BACK a previous statement (e.g., "нет, подожди — мы всё ещё на X", "забудь про Y", "forget Y", "actually we still use X"), ALWAYS generate an invalidation for the incorrect/outdated value. Use a short distinctive keyword as the contentPattern (e.g., "PostgreSQL" if the user says "забудь про PostgreSQL").
- When team composition changes (member leaves/joins), generate a COMPLETE updated team composition as the new fact, listing ALL current members with roles — not just the new member. For example, if the team was "Alice (backend), Bob (frontend), Carol (ML)" and Carol leaves and Dave joins for ML, the new fact should be "Команда: Alice (backend), Bob (frontend), Dave (ML)" — not just "Dave joined for ML".
- When the user sets a new preference that contradicts an earlier one (e.g., switching from "warm tone" to "concise, no emotions", or from "with examples" to "no examples"), ALWAYS generate an invalidation for the older contradicting preference. Use a distinctive keyword from the old preference as contentPattern (e.g., "тёплый" if switching away from warm tone).
- Do NOT extract meta-statements about the assistant's own memory state, confidence, or behavior (e.g., "assistant said it doesn't remember", "cannot confirm from memory"). Only extract facts about the USER and their world.
- If nothing is extractable, return empty arrays.
- Respond ONLY with valid JSON, no markdown fences, no extra text.

Response format:
{
  "items": [
    {"kind": "fact", "content": "...", "category": "identity", "tags": ["name"], "importance": 0.9},
    {"kind": "episode", "content": "...", "tags": ["architecture"], "importance": 0.6},
    {"kind": "identity", "content": "User prefers direct answers without preambles", "category": "style", "tags": ["communication"], "importance": 0.85}
  ],
  "invalidations": [
    {"contentPattern": "works at Company X", "kind": "fact", "reason": "user said they left Company X"}
  ]
}`;

const MAX_EXTRACTION_TOKENS = 1500;
const EXTRACTION_TEMPERATURE = 0.1;
const MAX_MESSAGE_CHARS = 3000;

@Injectable()
export class MemoryExtractorV2Service {
  private readonly logger = new Logger(MemoryExtractorV2Service.name);

  constructor(@Optional() private readonly llmService?: LlmService) {}

  isAvailable(): boolean {
    return this.llmService !== undefined && this.llmService !== null;
  }

  /**
   * Extract memories from the latest turn (user message + assistant response).
   */
  async extractFromTurn(
    userMessage: string,
    assistantResponse: string,
    recentContext?: string,
  ): Promise<MemoryExtractionResult | undefined> {
    if (!this.isAvailable()) return undefined;
    if (!userMessage.trim()) return undefined;

    const turnContent = this.buildTurnContent(userMessage, assistantResponse, recentContext);

    const messages: LlmMessage[] = [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
      { role: 'user', content: `Extract memories from this conversation turn:\n\n${turnContent}` },
    ];

    try {
      const result = await this.llmService!.complete(messages, {
        maxTokens: MAX_EXTRACTION_TOKENS,
        temperature: EXTRACTION_TEMPERATURE,
      });

      return this.parseResult(result.content);
    } catch (error) {
      this.logger.warn(`Memory extraction failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /**
   * Deep reflection at session end — analyzes entire session for higher-level learnings.
   */
  async reflectOnSession(
    sessionSummary: string,
  ): Promise<MemoryExtractionResult | undefined> {
    if (!this.isAvailable()) return undefined;

    const messages: LlmMessage[] = [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `This is a summary of an entire session. Extract high-level learnings, decisions, and important facts:\n\n${sessionSummary.slice(0, 5000)}`,
      },
    ];

    try {
      const result = await this.llmService!.complete(messages, {
        maxTokens: MAX_EXTRACTION_TOKENS,
        temperature: EXTRACTION_TEMPERATURE,
      });

      return this.parseResult(result.content);
    } catch (error) {
      this.logger.warn(`Session reflection failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private buildTurnContent(
    userMessage: string,
    assistantResponse: string,
    recentContext?: string,
  ): string {
    const parts: string[] = [];

    if (recentContext) {
      parts.push(`[Recent context]\n${recentContext.slice(0, 1000)}`);
    }

    parts.push(`[User]\n${userMessage.slice(0, MAX_MESSAGE_CHARS)}`);
    parts.push(`[Assistant]\n${assistantResponse.slice(0, MAX_MESSAGE_CHARS)}`);

    return parts.join('\n\n');
  }

  private parseResult(raw: string): MemoryExtractionResult | undefined {
    try {
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();

      const parsed = JSON.parse(cleaned) as Record<string, unknown>;

      const items = this.validateItems(parsed.items);
      const invalidations = this.validateInvalidations(parsed.invalidations);

      if (items.length === 0 && invalidations.length === 0) {
        return undefined;
      }

      return { items, invalidations };
    } catch (error) {
      this.logger.warn(`Failed to parse extraction result: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private validateItems(raw: unknown): ExtractedMemoryItem[] {
    if (!Array.isArray(raw)) return [];

    const validKinds = new Set<string>(['fact', 'episode', 'action', 'learning', 'skill', 'preference', 'identity']);

    return raw
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).kind === 'string' &&
        validKinds.has((item as Record<string, unknown>).kind as string) &&
        typeof (item as Record<string, unknown>).content === 'string' &&
        ((item as Record<string, unknown>).content as string).trim().length >= 3,
      )
      .map((item) => ({
        kind: item.kind as MemoryKind,
        content: (item.content as string).trim().slice(0, 500),
        category: typeof item.category === 'string' ? item.category.trim() : undefined,
        tags: Array.isArray(item.tags)
          ? (item.tags as unknown[]).filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase().trim()).slice(0, 5)
          : undefined,
        importance: typeof item.importance === 'number' && item.importance >= 0 && item.importance <= 1
          ? item.importance
          : undefined,
      }));
  }

  private validateInvalidations(raw: unknown): ExtractedInvalidation[] {
    if (!Array.isArray(raw)) return [];

    return raw
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).contentPattern === 'string' &&
        ((item as Record<string, unknown>).contentPattern as string).trim().length >= 2 &&
        typeof (item as Record<string, unknown>).reason === 'string',
      )
      .map((item) => ({
        contentPattern: (item.contentPattern as string).trim(),
        kind: typeof item.kind === 'string' ? (item.kind as MemoryKind) : undefined,
        reason: (item.reason as string).trim(),
      }));
  }
}
