import { Injectable, Logger, Optional } from '@nestjs/common';

import type { LlmService } from '../../llm/llm.service';
import { MemoryStoreService } from '../core/memory-store.service';
import type { MemoryEntry } from '../core/memory-entry.types';
import type { SessionReflectionResult } from './action-log.types';

const SESSION_REFLECTION_PROMPT = `You are a reflective AI assistant performing a deep end-of-session analysis.

Review the following session context and produce a structured JSON reflection:

Session context:
{context}

Recent memories created this session:
{recentMemories}

Produce a JSON response with:
{
  "summary": "2-3 sentence session summary",
  "keyDecisions": ["decision 1", "decision 2", ...],
  "openQuestions": ["unresolved question 1", ...],
  "learnings": ["insight or lesson 1", ...]
}

Rules:
- summary: concise overview of what happened
- keyDecisions: only significant choices made (max 5)
- openQuestions: things left unresolved that should be remembered (max 5)
- learnings: generalizable insights or lessons (max 5)
- Omit empty arrays
- Keep each item under 120 characters
- Respond ONLY with valid JSON, no markdown fences.`;

@Injectable()
export class SessionReflectionService {
  private readonly logger = new Logger(SessionReflectionService.name);

  constructor(
    private readonly memoryStore: MemoryStoreService,
    @Optional() private readonly llmService?: LlmService,
  ) {}

  isAvailable(): boolean {
    return Boolean(this.llmService);
  }

  async reflect(
    sessionContext: string,
    conversationId?: string,
    scopeKey?: string,
  ): Promise<SessionReflectionResult | undefined> {
    if (!this.llmService) {
      this.logger.warn('Session reflection skipped: no LLM service');
      return undefined;
    }

    if (!sessionContext || sessionContext.trim().length < 20) {
      return undefined;
    }

    try {
      // Get recent memories from this session
      const recentMemories = await this.memoryStore.query({
        horizons: ['working', 'short_term'],
        limit: 15,
        orderBy: 'createdAt',
        orderDirection: 'desc',
        ...(scopeKey ? { scopeKey } : {}),
      });

      const recentMemoriesSummary = recentMemories.length > 0
        ? recentMemories.map((m) => `- [${m.kind}] ${m.summary ?? m.content}`).join('\n')
        : '(none)';

      const prompt = SESSION_REFLECTION_PROMPT
        .replace('{context}', sessionContext.slice(0, 2000))
        .replace('{recentMemories}', recentMemoriesSummary);

      const result = await this.llmService.complete(
        [
          { role: 'system', content: prompt },
          { role: 'user', content: 'Perform the end-of-session reflection.' },
        ],
        { maxTokens: 600, temperature: 0.4 },
      );

      const parsed = this.parseReflection(result.content);
      if (!parsed) return undefined;

      // Save reflection entries
      const createdEntryIds: string[] = [];

      // Session summary as episode
      const summaryEntry = await this.memoryStore.create({
        kind: 'episode',
        content: parsed.summary,
        summary: `Session summary: ${parsed.summary.slice(0, 80)}`,
        source: 'agent_reflection',
        category: 'session_summary',
        tags: ['session', 'summary'],
        horizon: 'long_term',
        importance: 0.7,
        scopeKey,
        provenance: {
          conversationId,
          timestamp: new Date().toISOString(),
        },
      });
      createdEntryIds.push(summaryEntry.id);

      // Key decisions as episodes
      for (const decision of parsed.keyDecisions) {
        const entry = await this.memoryStore.create({
          kind: 'episode',
          content: decision,
          source: 'agent_reflection',
          category: 'decision',
          tags: ['session', 'decision'],
          horizon: 'long_term',
          importance: 0.6,
          scopeKey,
          provenance: {
            conversationId,
            timestamp: new Date().toISOString(),
          },
        });
        createdEntryIds.push(entry.id);
      }

      // Open questions as episodes
      for (const question of parsed.openQuestions) {
        const entry = await this.memoryStore.create({
          kind: 'episode',
          content: question,
          source: 'agent_reflection',
          category: 'open_question',
          tags: ['session', 'open_question'],
          horizon: 'short_term',
          importance: 0.5,
          scopeKey,
          provenance: {
            conversationId,
            timestamp: new Date().toISOString(),
          },
        });
        createdEntryIds.push(entry.id);
      }

      // Learnings
      for (const learning of parsed.learnings) {
        const entry = await this.memoryStore.create({
          kind: 'learning',
          content: learning,
          source: 'agent_reflection',
          category: 'session_learning',
          tags: ['session', 'learning'],
          horizon: 'long_term',
          importance: 0.8,
          scopeKey,
          provenance: {
            conversationId,
            timestamp: new Date().toISOString(),
          },
        });
        createdEntryIds.push(entry.id);
      }

      // Promote important working memories to short_term
      await this.promoteWorkingMemories();

      this.logger.debug(
        `Session reflection complete: ${createdEntryIds.length} entries created (summary=1, decisions=${parsed.keyDecisions.length}, questions=${parsed.openQuestions.length}, learnings=${parsed.learnings.length})`,
      );

      return {
        ...parsed,
        createdEntryIds,
      };
    } catch (err) {
      this.logger.warn(`Session reflection failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private async promoteWorkingMemories(): Promise<void> {
    const workingMemories = await this.memoryStore.query({
      horizons: ['working'],
      minImportance: 0.5,
      limit: 20,
    });

    for (const memory of workingMemories) {
      if (memory.importance >= 0.5 || memory.pinned) {
        await this.memoryStore.update(memory.id, { horizon: 'short_term' });
      }
    }

    // Clear remaining working memory
    await this.memoryStore.clearWorkingMemory();
  }

  private parseReflection(raw: string): Omit<SessionReflectionResult, 'createdEntryIds'> | undefined {
    try {
      let text = raw.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }

      const parsed = JSON.parse(text) as Record<string, unknown>;
      const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
      if (!summary) return undefined;

      const keyDecisions = this.extractStringArray(parsed.keyDecisions, 5);
      const openQuestions = this.extractStringArray(parsed.openQuestions, 5);
      const learnings = this.extractStringArray(parsed.learnings, 5);

      if (keyDecisions.length === 0 && openQuestions.length === 0 && learnings.length === 0) {
        // At minimum we need something beyond just a summary
        return { summary, keyDecisions: [], openQuestions: [], learnings: [] };
      }

      return { summary, keyDecisions, openQuestions, learnings };
    } catch {
      this.logger.warn('Failed to parse session reflection JSON');
      return undefined;
    }
  }

  private extractStringArray(value: unknown, max: number): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 3)
      .slice(0, max)
      .map((s) => s.trim());
  }
}
