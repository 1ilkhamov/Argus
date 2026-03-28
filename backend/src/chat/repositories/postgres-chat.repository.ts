import { Injectable, Logger } from '@nestjs/common';

import type { ArchivedChatMessageHit, ArchivedChatSearchRequest } from '../../memory/archive/archive-chat-retrieval.types';
import { PostgresConnectionService } from '../../storage/postgres-connection.service';
import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import { ChatRepository } from './chat.repository';

@Injectable()
export class PostgresChatRepository extends ChatRepository {
  private readonly logger = new Logger(PostgresChatRepository.name);

  constructor(private readonly connectionService: PostgresConnectionService) {
    super();
  }

  async createConversation(scopeKey?: string): Promise<Conversation> {
    const conversation = new Conversation({ scopeKey });
    await this.saveConversation(conversation);
    return conversation;
  }

  async getConversation(id: string, scopeKey?: string): Promise<Conversation | undefined> {
    const pool = await this.connectionService.getPool();
    const conversationResult = await pool.query<{
      id: string;
      scope_key: string;
      title: string;
      created_at: Date | string;
      updated_at: Date | string;
    }>(
      `
        SELECT id, scope_key, title, created_at, updated_at
        FROM conversations
        WHERE id = $1
        ${scopeKey ? 'AND scope_key = $2' : ''}
      `,
      scopeKey ? [id, scopeKey] : [id],
    );

    const rawConversation = conversationResult.rows[0];
    if (!rawConversation) {
      return undefined;
    }

    const messageResult = await pool.query<{
      id: string;
      conversation_id: string;
      role: Message['role'];
      content: string;
      created_at: Date | string;
    }>(
      `
        SELECT id, conversation_id, role, content, created_at
        FROM messages
        WHERE conversation_id = $1
        ORDER BY position ASC
      `,
      [id],
    );

    return new Conversation({
      id: rawConversation.id,
      scopeKey: rawConversation.scope_key,
      title: rawConversation.title,
      createdAt: new Date(rawConversation.created_at),
      updatedAt: new Date(rawConversation.updated_at),
      messages: messageResult.rows.map(
        (message: {
          id: string;
          conversation_id: string;
          role: Message['role'];
          content: string;
          created_at: Date | string;
        }) =>
        new Message({
          id: message.id,
          conversationId: message.conversation_id,
          role: message.role,
          content: message.content,
          createdAt: new Date(message.created_at),
        }),
      ),
    });
  }

  async getAllConversations(scopeKey?: string): Promise<Conversation[]> {
    const pool = await this.connectionService.getPool();
    const result = scopeKey
      ? await pool.query<{ id: string }>(
          `
            SELECT id
            FROM conversations
            WHERE scope_key = $1
            ORDER BY updated_at DESC
          `,
          [scopeKey],
        )
      : await pool.query<{ id: string }>(
          `
            SELECT id
            FROM conversations
            ORDER BY updated_at DESC
          `,
        );

    const hydrated = await Promise.all(
      result.rows.map(({ id }: { id: string }) => this.getConversation(id, scopeKey)),
    );
    return hydrated.filter(
      (conversation: Conversation | undefined): conversation is Conversation => Boolean(conversation),
    );
  }

  async saveConversation(conversation: Conversation): Promise<void> {
    const pool = await this.connectionService.getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(
        `
          INSERT INTO conversations (id, scope_key, title, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT(id) DO UPDATE SET
            scope_key = EXCLUDED.scope_key,
            title = EXCLUDED.title,
            created_at = EXCLUDED.created_at,
            updated_at = EXCLUDED.updated_at
        `,
        [
          conversation.id,
          conversation.scopeKey,
          conversation.title,
          conversation.createdAt.toISOString(),
          conversation.updatedAt.toISOString(),
        ],
      );

      await client.query('DELETE FROM messages WHERE conversation_id = $1', [conversation.id]);

      for (const [index, message] of conversation.messages.entries()) {
        await client.query(
          `
            INSERT INTO messages (id, conversation_id, role, content, created_at, position)
            VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            message.id,
            message.conversationId,
            message.role,
            message.content,
            message.createdAt.toISOString(),
            index,
          ],
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteConversation(id: string, scopeKey?: string): Promise<boolean> {
    const pool = await this.connectionService.getPool();
    const result = await pool.query(
      `DELETE FROM conversations WHERE id = $1${scopeKey ? ' AND scope_key = $2' : ''}`,
      scopeKey ? [id, scopeKey] : [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async searchArchivedChatMessages(request: ArchivedChatSearchRequest): Promise<ArchivedChatMessageHit[]> {
    const pool = await this.connectionService.getPool();
    const tokens = request.tokens.map((token) => token.toLocaleLowerCase()).filter((token) => token.length > 0);
    if (tokens.length === 0) {
      return [];
    }

    const queryText = tokens.join(' ');
    try {
      const params: unknown[] = [queryText];
      const filters: string[] = [];
      if (request.scopeKey) {
        params.push(request.scopeKey);
        filters.push(`c.scope_key = $${params.length}`);
      }
      if (request.excludeConversationId) {
        params.push(request.excludeConversationId);
        filters.push(`m.conversation_id != $${params.length}`);
      }
      params.push(Math.max(request.limit * 6, request.limit));

      const limitParamIndex = params.length;
      const filterClause = filters.length > 0 ? `AND ${filters.join(' AND ')}` : '';
      const result = await pool.query<{
        message_id: string;
        conversation_id: string;
        role: 'user' | 'assistant' | 'system';
        content: string;
        created_at: Date | string;
        conversation_updated_at: Date | string;
      }>(
        `
          SELECT m.id AS message_id,
                 m.conversation_id,
                 m.role,
                 m.content,
                 m.created_at,
                 c.updated_at AS conversation_updated_at
          FROM messages m
          JOIN conversations c ON c.id = m.conversation_id
          WHERE to_tsvector('simple', m.content) @@ plainto_tsquery('simple', $1)
          ${filterClause}
          ORDER BY c.updated_at DESC
          LIMIT $${limitParamIndex}
        `,
        params,
      );

      const scored = result.rows
        .map((row: {
          message_id: string;
          conversation_id: string;
          role: 'user' | 'assistant' | 'system';
          content: string;
          created_at: Date | string;
          conversation_updated_at: Date | string;
        }) => {
          const normalized = (row.content ?? '').toLocaleLowerCase();
          let matchCount = 0;
          for (const token of tokens) {
            if (normalized.includes(token)) {
              matchCount += 1;
            }
          }

          return {
            conversationId: row.conversation_id,
            messageId: row.message_id,
            role: row.role,
            content: row.content,
            createdAt: new Date(row.created_at).toISOString(),
            conversationUpdatedAt: new Date(row.conversation_updated_at).toISOString(),
            matchCount,
          } satisfies ArchivedChatMessageHit;
        })
        .filter((hit: ArchivedChatMessageHit) => hit.matchCount > 0);

      return scored
        .sort((left: ArchivedChatMessageHit, right: ArchivedChatMessageHit) => {
          if (right.matchCount !== left.matchCount) {
            return right.matchCount - left.matchCount;
          }

          return right.conversationUpdatedAt.localeCompare(left.conversationUpdatedAt);
        })
        .slice(0, request.limit);
    } catch {
      // fall through to ILIKE search
    }

    const params: unknown[] = [];
    const filters: string[] = [];
    if (request.scopeKey) {
      params.push(request.scopeKey);
      filters.push(`c.scope_key = $${params.length}`);
    }
    if (request.excludeConversationId) {
      params.push(request.excludeConversationId);
      filters.push(`m.conversation_id != $${params.length}`);
    }

    const tokenClauses = tokens
      .map((token) => {
        params.push(`%${token}%`);
        return `m.content ILIKE $${params.length}`;
      })
      .join(' OR ');

    params.push(Math.max(request.limit * 6, request.limit));
    const limitParamIndex = params.length;
    const filterClause = filters.length > 0 ? `${filters.join(' AND ')} AND ` : '';

    const result = await pool.query<{
      message_id: string;
      conversation_id: string;
      role: 'user' | 'assistant' | 'system';
      content: string;
      created_at: Date | string;
      conversation_updated_at: Date | string;
    }>(
      `
        SELECT m.id AS message_id,
               m.conversation_id,
               m.role,
               m.content,
               m.created_at,
               c.updated_at AS conversation_updated_at
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE ${filterClause}(${tokenClauses})
        ORDER BY c.updated_at DESC
        LIMIT $${limitParamIndex}
      `,
      params,
    );

    const scored = result.rows
      .map((row: {
        message_id: string;
        conversation_id: string;
        role: 'user' | 'assistant' | 'system';
        content: string;
        created_at: Date | string;
        conversation_updated_at: Date | string;
      }) => {
        const normalized = (row.content ?? '').toLocaleLowerCase();
        let matchCount = 0;
        for (const token of tokens) {
          if (normalized.includes(token)) {
            matchCount += 1;
          }
        }

        return {
          conversationId: row.conversation_id,
          messageId: row.message_id,
          role: row.role,
          content: row.content,
          createdAt: new Date(row.created_at).toISOString(),
          conversationUpdatedAt: new Date(row.conversation_updated_at).toISOString(),
          matchCount,
        } satisfies ArchivedChatMessageHit;
      })
      .filter((hit: ArchivedChatMessageHit) => hit.matchCount > 0);

    return scored
      .sort((left: ArchivedChatMessageHit, right: ArchivedChatMessageHit) => {
        if (right.matchCount !== left.matchCount) {
          return right.matchCount - left.matchCount;
        }

        return right.conversationUpdatedAt.localeCompare(left.conversationUpdatedAt);
      })
      .slice(0, request.limit);
  }

  async checkHealth(): Promise<{
    status: 'up' | 'down';
    driver: string;
    target: string;
    conversationCount: number;
    error?: string;
  }> {
    try {
      const pool = await this.connectionService.getPool();
      const result = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM conversations');

      return {
        status: 'up',
        driver: 'postgres',
        target: this.connectionService.getMaskedPostgresUrl(),
        conversationCount: Number.parseInt(result.rows[0]?.count ?? '0', 10),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown storage error';
      return {
        status: 'down',
        driver: 'postgres',
        target: this.connectionService.getMaskedPostgresUrl(),
        conversationCount: 0,
        error: message,
      };
    }
  }
}
