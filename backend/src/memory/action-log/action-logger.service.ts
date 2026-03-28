import { Injectable, Logger, Optional } from '@nestjs/common';

import type { EmbeddingService } from '../../embedding/embedding.service';
import type { LlmService } from '../../llm/llm.service';
import { MemoryStoreService } from '../core/memory-store.service';
import type { QdrantVectorService } from '../qdrant/qdrant-vector.service';
import type { ActionLogEntry, ActionLogResult, ActionReflection } from './action-log.types';

const MAX_RESULT_LENGTH = 500;
const MAX_ARGS_LENGTH = 300;

const REFLECTION_PROMPT = `You are a reflective AI assistant analyzing the result of an action you just performed.

Given the following action:
- Tool: {toolName}
- Args: {args}
- Success: {success}
- Result: {result}
{errorLine}

Analyze the result and provide a brief JSON response:
{
  "outcome": "brief description of what happened",
  "issues": "what went wrong, if anything (omit if no issues)",
  "learning": "what insight or lesson can be derived (omit if trivial)",
  "skillUpdate": "any skill or capability update needed (omit if none)"
}

Only include fields that have meaningful content. Keep each field under 100 characters.
Respond ONLY with valid JSON, no markdown fences.`;

@Injectable()
export class ActionLoggerService {
  private readonly logger = new Logger(ActionLoggerService.name);

  constructor(
    private readonly memoryStore: MemoryStoreService,
    @Optional() private readonly llmService?: LlmService,
    @Optional() private readonly embeddingService?: EmbeddingService,
    @Optional() private readonly qdrantService?: QdrantVectorService,
  ) {}

  async logAction(entry: ActionLogEntry): Promise<ActionLogResult> {
    const truncatedResult = entry.result.length > MAX_RESULT_LENGTH
      ? entry.result.slice(0, MAX_RESULT_LENGTH) + '…'
      : entry.result;

    const truncatedArgs = JSON.stringify(entry.args).length > MAX_ARGS_LENGTH
      ? JSON.stringify(entry.args).slice(0, MAX_ARGS_LENGTH) + '…'
      : JSON.stringify(entry.args);

    const content = [
      `Tool: ${entry.toolName}`,
      `Args: ${truncatedArgs}`,
      `Success: ${entry.success}`,
      ...(entry.durationMs != null ? [`Duration: ${entry.durationMs}ms`] : []),
      `Result: ${truncatedResult}`,
      ...(entry.error ? [`Error: ${entry.error}`] : []),
    ].join('\n');

    const summary = entry.success
      ? `${entry.toolName}(${Object.keys(entry.args).join(', ')}) → OK`
      : `${entry.toolName}(${Object.keys(entry.args).join(', ')}) → FAILED: ${entry.error ?? 'unknown'}`;

    // Create action entry
    const actionEntry = await this.memoryStore.create({
      kind: 'action',
      content,
      summary,
      source: 'tool_result',
      category: entry.toolName,
      tags: [entry.toolName, entry.success ? 'success' : 'error'],
      horizon: 'short_term',
      importance: entry.success ? 0.3 : 0.5, // failures are more important
      scopeKey: entry.scopeKey,
      provenance: {
        conversationId: entry.conversationId,
        messageId: entry.messageId,
        timestamp: new Date().toISOString(),
      },
    });

    this.logger.debug(`Logged action ${actionEntry.id}: ${summary}`);

    // Try LLM reflection for non-trivial actions
    let learningEntryId: string | undefined;
    if (this.llmService && this.shouldReflect(entry)) {
      try {
        const reflection = await this.reflect(entry, truncatedResult, truncatedArgs);
        if (reflection?.learning) {
          const learningEntry = await this.memoryStore.create({
            kind: 'learning',
            content: reflection.learning,
            summary: reflection.outcome,
            source: 'agent_reflection',
            category: entry.toolName,
            tags: [entry.toolName, 'reflection'],
            horizon: 'long_term',
            importance: 0.7,
            scopeKey: entry.scopeKey,
            provenance: {
              conversationId: entry.conversationId,
              messageId: entry.messageId,
              timestamp: new Date().toISOString(),
            },
          });
          learningEntryId = learningEntry.id;
          this.logger.debug(`Reflected on action → learning ${learningEntry.id}: ${reflection.learning}`);
        }
      } catch (err) {
        this.logger.warn(`Action reflection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Embed asynchronously
    this.embedEntry(actionEntry.id, content).catch(() => {});

    return { actionEntryId: actionEntry.id, learningEntryId };
  }

  private shouldReflect(entry: ActionLogEntry): boolean {
    // Reflect on failures and non-trivial actions
    if (!entry.success) return true;
    if (entry.result.length > 200) return true;
    // Skip trivial lookups
    return false;
  }

  private async reflect(
    entry: ActionLogEntry,
    truncatedResult: string,
    truncatedArgs: string,
  ): Promise<ActionReflection | undefined> {
    if (!this.llmService) return undefined;

    const prompt = REFLECTION_PROMPT
      .replace('{toolName}', entry.toolName)
      .replace('{args}', truncatedArgs)
      .replace('{success}', String(entry.success))
      .replace('{result}', truncatedResult)
      .replace('{errorLine}', entry.error ? `- Error: ${entry.error}` : '');

    const result = await this.llmService.complete(
      [
        { role: 'system', content: prompt },
        { role: 'user', content: 'Analyze this action result.' },
      ],
      { maxTokens: 300, temperature: 0.3 },
    );

    try {
      let text = result.content.trim();
      // Strip markdown fences
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      const parsed = JSON.parse(text) as ActionReflection;
      if (!parsed.outcome || typeof parsed.outcome !== 'string') return undefined;
      return parsed;
    } catch {
      this.logger.warn('Failed to parse action reflection JSON');
      return undefined;
    }
  }

  private async embedEntry(entryId: string, content: string): Promise<void> {
    if (!this.embeddingService || !this.qdrantService) return;
    try {
      const result = await this.embeddingService.embed(content);
      if (!result?.embedding) return;
      await this.qdrantService.upsertPoints([
        {
          id: entryId,
          vector: result.embedding,
          payload: { kind: 'action', entryId },
        },
      ]);
    } catch {
      // Non-critical
    }
  }
}
