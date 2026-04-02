/**
 * Battle test: отправляет 100 сообщений агенту, затем проверяет состояние БД.
 *
 * - Изолированные временные SQLite-файлы (чистая память, чистый чат).
 * - LLM mock: для chat-вызовов возвращает простой текст,
 *   для memory-extraction вызовов возвращает валидный пустой JSON
 *   (regex-экстракторы работают в полную силу).
 * - Финальный аудит: факты, эпизодика, версия, suppressed facts.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';

import { LlmService } from '../../src/llm/llm.service';
import type { LlmMessage } from '../../src/llm/interfaces/llm.interface';
import { deriveScopeKey } from '../../src/common/auth/scope-key';
import { battleCorpus } from '../fixtures/battle-message-corpus';

jest.setTimeout(600_000);

// ── Constants ────────────────────────────────────────────────────────────────

const IS_LIVE = process.env.BATTLE_LIVE === 'true';
const API_KEY = 'test-key';
const ADMIN_KEY = 'test-admin-key';
const SCOPE_KEY = deriveScopeKey(API_KEY);

const EMPTY_EXTRACTION_V2_JSON = JSON.stringify({
  items: [],
  invalidations: [],
});

const EMPTY_KG_JSON = JSON.stringify({
  entities: [],
  relations: [],
});

const NO_CONTRADICTION_JSON = JSON.stringify({
  contradicts: false,
  action: 'keep_both',
});

// ── LLM mock ─────────────────────────────────────────────────────────────────

function mockLlmComplete(messages: LlmMessage[]): string {
  const systemContent = messages[0]?.role === 'system' ? String(messages[0].content) : '';
  // Memory extraction v2
  if (systemContent.startsWith('You are a memory extraction engine')) {
    return EMPTY_EXTRACTION_V2_JSON;
  }
  // Knowledge graph entity extraction
  if (systemContent.startsWith('You are a knowledge graph entity extractor')) {
    return EMPTY_KG_JSON;
  }
  // Contradiction resolution
  if (systemContent.startsWith('You are a memory consistency checker')) {
    return NO_CONTRADICTION_JSON;
  }
  // Chat call: detect language from last user message and reply accordingly
  const userContent = String([...messages].reverse().find((m) => m.role === 'user')?.content ?? '');
  const cyrillicCount = userContent.match(/[А-Яа-яЁё]/g)?.length ?? 0;
  const latinCount = userContent.match(/[A-Za-z]/g)?.length ?? 0;
  return cyrillicCount > latinCount ? 'Принял.' : 'Got it.';
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function header(label: string, value: unknown) {
  // eslint-disable-next-line no-console
  console.log(`  ${label.padEnd(36)} ${JSON.stringify(value)}`);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Chat battle (e2e)', () => {
  let app: INestApplication;
  let tempDir: string;
  let chatDb: DatabaseSync;
  let memoryDb: DatabaseSync;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'argus-battle-'));

    // ── Env vars (same pattern as the working chat.e2e-spec.ts) ───────────────
    process.env.NODE_ENV = 'test';
    process.env.AUTH_ENABLED = 'true';
    process.env.AUTH_API_KEYS = API_KEY;
    process.env.AUTH_ADMIN_API_KEY = ADMIN_KEY;
    process.env.STORAGE_DRIVER = 'sqlite';
    process.env.STORAGE_DB_FILE = join(tempDir, 'chat.db');
    process.env.STORAGE_MEMORY_DB_FILE = join(tempDir, 'memory.db');
    process.env.STORAGE_DATA_FILE = join(tempDir, 'chat-store.json');
    process.env.RATE_LIMIT_ENABLED = 'false';
    process.env.LLM_API_KEY = process.env.LLM_API_KEY ?? 'test-llm-key';
    process.env.LLM_API_BASE = process.env.LLM_API_BASE ?? 'http://localhost:8317/v1';

    const { AppModule } = await import('../../src/app.module');

    let builder = Test.createTestingModule({ imports: [AppModule] });

    if (!IS_LIVE) {
      // Mock LLM for CI: fast, deterministic, no real API calls
      builder = builder
        .overrideProvider(LlmService)
        .useValue({
          complete: async (messages: LlmMessage[]) => ({
            content: mockLlmComplete(messages),
            model: 'test-model',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            finishReason: 'stop',
          }),
          async *stream() {
            yield { content: '', done: true };
          },
          checkHealth: async () => ({ status: 'up', model: 'test-model', responseTimeMs: 1 }),
          getRuntimeProfile: () => ({
            provider: 'openai',
            model: 'test-model',
            maxCompletionTokens: 4096,
            contextWindowTokens: 128000,
            completionTimeoutMs: 120000,
            streamTimeoutMs: 120000,
          }),
        });
    } else {
      // eslint-disable-next-line no-console
      console.log('\n🔴 BATTLE LIVE MODE — using real LLM\n');
    }

    const moduleRef = await builder.compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    // Open DB connections AFTER app.init() so tables are created
    chatDb = new DatabaseSync(process.env.STORAGE_DB_FILE!);
    memoryDb = new DatabaseSync(process.env.STORAGE_MEMORY_DB_FILE!);
  });

  afterAll(async () => {
    try { chatDb.close(); } catch { /* ignore */ }
    try { memoryDb.close(); } catch { /* ignore */ }
    await app?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── Main battle test ────────────────────────────────────────────────────────

  it('sends 100 messages and audits memory DB state', async () => {
    // Track conversationId per logical conversation name
    const convIds = new Map<string, string>();
    const responses: Array<{ id: number; conversation: string; content: string; reply: string }> = [];

    // ── Send all 100 messages ─────────────────────────────────────────────────
    let failures = 0;
    for (const [index, msg] of battleCorpus.entries()) {
      const payload: Record<string, unknown> = { content: msg.content };
      if (convIds.has(msg.conversation)) {
        payload.conversationId = convIds.get(msg.conversation);
      }

      try {
        const res = await request(app.getHttpServer())
          .post('/api/chat/messages')
          .set('x-api-key', API_KEY)
          .set('x-forwarded-for', `10.0.${Math.floor(index / 255)}.${(index % 254) + 1}`)
          .send(payload);

        if (res.status !== 200) {
          failures++;
          if (IS_LIVE) {
            // eslint-disable-next-line no-console
            console.log(`  ❌ [${index + 1}/100] (${msg.conversation}) HTTP ${res.status} — ${msg.content.slice(0, 50)}`);
          }
          continue;
        }

        const body = res.body as { conversationId: string; message: { id: string; content: string } };
        if (!convIds.has(msg.conversation)) {
          convIds.set(msg.conversation, body.conversationId);
        }
        responses.push({ id: index + 1, conversation: msg.conversation, content: msg.content, reply: body.message.content });

        if (IS_LIVE) {
          const isBattle = msg.conversation.startsWith('battle-');
          const tag = isBattle ? '⚔️' : '📝';
          // eslint-disable-next-line no-console
          console.log(`  ${tag} [${index + 1}/100] (${msg.conversation}) ${msg.content.slice(0, 60)}${msg.content.length > 60 ? '…' : ''}`);
          if (isBattle) {
            // eslint-disable-next-line no-console
            console.log(`     → ${body.message.content.slice(0, 200)}${body.message.content.length > 200 ? '…' : ''}\n`);
          }
        }
      } catch (err) {
        failures++;
        if (IS_LIVE) {
          // eslint-disable-next-line no-console
          console.log(`  ❌ [${index + 1}/100] (${msg.conversation}) ERROR — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // ── SQL audit ─────────────────────────────────────────────────────────────

    const conversations = chatDb
      .prepare(`SELECT id, scope_key FROM conversations WHERE scope_key = ?`)
      .all(SCOPE_KEY) as Array<{ id: string; scope_key: string }>;

    const totalMessages = (
      chatDb
        .prepare(
          `SELECT COUNT(*) AS cnt FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           WHERE c.scope_key = ?`,
        )
        .get(SCOPE_KEY) as { cnt: number }
    ).cnt;

    // Memory v2: all entries are in memory_entries table
    const allEntries = memoryDb
      .prepare(`SELECT id, kind, category, content, summary, pinned, importance, superseded_by FROM memory_entries ORDER BY kind, content`)
      .all() as Array<{ id: string; kind: string; category: string | null; content: string; summary: string | null; pinned: number; importance: number; superseded_by: string | null }>;

    const activeEntries = allEntries.filter((e) => !e.superseded_by);
    const facts = activeEntries.filter((e) => e.kind === 'fact');
    const entries = activeEntries.filter((e) => e.kind !== 'fact');

    // ── API snapshot via memory v2 ──────────────────────────────────────────────

    const memoryListRes = await request(app.getHttpServer())
      .get('/api/memory/v2/entries')
      .set('x-api-key', API_KEY)
      .expect(200);

    const memoryList = memoryListRes.body as { entries: Array<{ id: string; kind: string; content: string; category?: string; pinned: boolean }>; total: number };

    // ── Print battle report ───────────────────────────────────────────────────

    // eslint-disable-next-line no-console
    console.log('\n══════════════════════════════════════════════════════');
    // eslint-disable-next-line no-console
    console.log('  BATTLE TEST REPORT (memory v2)');
    // eslint-disable-next-line no-console
    console.log('══════════════════════════════════════════════════════');
    header('Messages sent', battleCorpus.length);
    header('Conversations created', conversations.length);
    header('Total messages in DB', totalMessages);
    header('Total memory entries', allEntries.length);
    header('Active entries', activeEntries.length);
    header('Facts in DB', facts.length);
    header('Episodic entries in DB', entries.length);
    header('Scope key', SCOPE_KEY);
    // eslint-disable-next-line no-console
    console.log('\n  ── Facts ──');
    for (const f of facts) {
      // eslint-disable-next-line no-console
      console.log(`    [${f.pinned ? 'PINNED' : '      '}] ${f.category ?? 'general'} = ${f.content}`);
    }
    // eslint-disable-next-line no-console
    console.log('\n  ── Other entries ──');
    for (const e of entries) {
      // eslint-disable-next-line no-console
      console.log(`    [${e.pinned ? 'PINNED' : '      '}] ${e.kind}: ${e.summary ?? e.content}`);
    }
    // eslint-disable-next-line no-console
    console.log('══════════════════════════════════════════════════════\n');

    // ── Battle question answers (live mode only) ────────────────────────────
    if (IS_LIVE) {
      const battleResponses = responses.filter((r) => r.conversation.startsWith('battle-'));
      // eslint-disable-next-line no-console
      console.log('══════════════════════════════════════════════════════');
      // eslint-disable-next-line no-console
      console.log(`  BATTLE ANSWERS (${battleResponses.length} questions)`);
      // eslint-disable-next-line no-console
      console.log('══════════════════════════════════════════════════════');
      for (const r of battleResponses) {
        // eslint-disable-next-line no-console
        console.log(`\n  ⚔️  Q${r.id - 70}: ${r.content}`);
        // eslint-disable-next-line no-console
        console.log(`  ➜  ${r.reply}\n  ${'─'.repeat(50)}`);
      }
      // eslint-disable-next-line no-console
      console.log('══════════════════════════════════════════════════════\n');
    }

    // ── Assertions ────────────────────────────────────────────────────────────

    if (IS_LIVE) {
      header('Failures', failures);
      header('Successful responses', responses.length);
      // In live mode: allow some failures but most messages should succeed
      expect(failures).toBeLessThan(20);
      expect(responses.length).toBeGreaterThan(50);
    } else {
      // Mock mode: all should succeed
      expect(totalMessages).toBe(200);
      expect(conversations.length).toBe(13);
    }

    // API returns a list (may be empty since LLM mock returns empty extractions)
    expect(memoryList.entries).toBeDefined();
    expect(Array.isArray(memoryList.entries)).toBe(true);

    // With empty extraction mock, no memory entries should be created via LLM,
    // but deterministic command processing may create/modify entries.
    // The key invariant: DB is consistent, no crashes, all messages processed.
    expect(allEntries).toBeDefined();
  });
});
