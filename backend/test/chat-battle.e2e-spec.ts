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

import { LlmService } from '../src/llm/llm.service';
import { getTextContent, type LlmMessage } from '../src/llm/interfaces/llm.interface';
import { deriveScopeKey } from '../src/common/auth/scope-key';
import { battleCorpus } from './battle-message-corpus';

jest.setTimeout(180_000);

// ── Constants ────────────────────────────────────────────────────────────────

const API_KEY = 'test-key';
const ADMIN_KEY = 'test-admin-key';
const SCOPE_KEY = deriveScopeKey(API_KEY);

const EMPTY_EXTRACTION_JSON = JSON.stringify({
  facts: [],
  episodes: [],
  invalidatedFactKeys: [],
  invalidatedEpisodeKinds: [],
});

// ── LLM mock ─────────────────────────────────────────────────────────────────

function mockLlmComplete(messages: LlmMessage[]): string {
  const systemContent = messages[0]?.role === 'system' ? getTextContent(messages[0].content) : '';
  // Extraction calls have a dedicated short system prompt
  if (systemContent.startsWith('You are a structured memory extractor')) {
    return EMPTY_EXTRACTION_JSON;
  }
  // Chat call: detect language from last user message and reply accordingly
  const userContent = getTextContent([...messages].reverse().find((m) => m.role === 'user')?.content ?? '');
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
    process.env.LLM_API_KEY = 'test-llm-key';
    process.env.LLM_API_BASE = 'http://localhost:8317/v1';

    const { AppModule } = await import('../src/app.module');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
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
      })
      .compile();

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
    for (const [index, msg] of battleCorpus.entries()) {
      const payload: Record<string, unknown> = { content: msg.content };
      if (convIds.has(msg.conversation)) {
        payload.conversationId = convIds.get(msg.conversation);
      }

      const res = await request(app.getHttpServer())
        .post('/api/chat/messages')
        .set('x-api-key', API_KEY)
        .set('x-forwarded-for', `10.0.${Math.floor(index / 255)}.${(index % 254) + 1}`)
        .send(payload)
        .expect(200);

      const body = res.body as { conversationId: string; message: { id: string; content: string } };
      if (!convIds.has(msg.conversation)) {
        convIds.set(msg.conversation, body.conversationId);
      }
      responses.push({ id: index + 1, conversation: msg.conversation, content: msg.content, reply: body.message.content });
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

    const facts = memoryDb
      .prepare(`SELECT fact_key, fact_value, pinned FROM agent_user_profile_facts WHERE scope_key = ? ORDER BY fact_key`)
      .all(SCOPE_KEY) as Array<{ fact_key: string; fact_value: string; pinned: number }>;

    const entries = memoryDb
      .prepare(`SELECT kind, summary, pinned FROM agent_episodic_memory_entries WHERE scope_key = ? ORDER BY kind, summary`)
      .all(SCOPE_KEY) as Array<{ kind: string; summary: string; pinned: number }>;

    const meta = memoryDb
      .prepare(`SELECT version, last_processed_message_id, suppressed_facts_json FROM managed_memory_scope_state WHERE scope_key = ?`)
      .get(SCOPE_KEY) as { version: number; last_processed_message_id: string | null; suppressed_facts_json: string | null } | undefined;

    const suppressedFacts: Array<{ key: string; value: string }> = JSON.parse(meta?.suppressed_facts_json ?? '[]');

    // ── User & admin API snapshots ────────────────────────────────────────────

    const userMemRes = await request(app.getHttpServer())
      .get('/api/chat/memory')
      .set('x-api-key', API_KEY)
      .expect(200);

    const adminMemRes = await request(app.getHttpServer())
      .get('/api/chat/memory/admin/snapshot')
      .query({ scopeKey: SCOPE_KEY })
      .set('x-api-key', ADMIN_KEY)
      .expect(200);

    const userMem = userMemRes.body as { userFacts: Array<{ key: string; value: string }>; episodicMemories: Array<{ kind: string; summary: string }> };
    const adminMem = adminMemRes.body as {
      userFacts: Array<{ key: string; value: string }>;
      episodicMemories: Array<{ kind: string; summary: string }>;
      suppressedFacts?: Array<{ key: string; value: string }>;
    };

    // ── Print battle report ───────────────────────────────────────────────────

    // eslint-disable-next-line no-console
    console.log('\n══════════════════════════════════════════════════════');
    // eslint-disable-next-line no-console
    console.log('  BATTLE TEST REPORT');
    // eslint-disable-next-line no-console
    console.log('══════════════════════════════════════════════════════');
    header('Messages sent', battleCorpus.length);
    header('Conversations created', conversations.length);
    header('Total messages in DB', totalMessages);
    header('Facts in DB', facts.length);
    header('Episodic entries in DB', entries.length);
    header('Memory version', meta?.version ?? 0);
    header('Suppressed facts', suppressedFacts.length);
    header('Scope key', SCOPE_KEY);
    // eslint-disable-next-line no-console
    console.log('\n  ── Facts ──');
    for (const f of facts) {
      // eslint-disable-next-line no-console
      console.log(`    [${f.pinned ? 'PINNED' : '      '}] ${f.fact_key} = ${f.fact_value}`);
    }
    // eslint-disable-next-line no-console
    console.log('\n  ── Episodic ──');
    for (const e of entries) {
      // eslint-disable-next-line no-console
      console.log(`    [${e.pinned ? 'PINNED' : '      '}] ${e.kind}: ${e.summary}`);
    }
    if (suppressedFacts.length > 0) {
      // eslint-disable-next-line no-console
      console.log('\n  ── Suppressed ──');
      for (const s of suppressedFacts) {
        // eslint-disable-next-line no-console
        console.log(`    ${s.key} = ${s.value}`);
      }
    }
    // eslint-disable-next-line no-console
    console.log('══════════════════════════════════════════════════════\n');

    // ── Assertions ────────────────────────────────────────────────────────────

    // We sent 100 messages → 200 rows (100 user + 100 assistant)
    expect(totalMessages).toBe(200);

    // All 8 logical conversations were created
    expect(conversations.length).toBe(8);

    // Memory DB version advanced (at least one commit happened)
    expect((meta?.version ?? 0)).toBeGreaterThan(0);

    // Last processed cursor is set
    expect(meta?.last_processed_message_id).toBeTruthy();

    // After re-seed: name should be "Илья" (seeded in 'seed', forgotten in 'cmds', reseeded in 'reseed')
    const nameFact = facts.find((f) => f.fact_key === 'name');
    expect(nameFact).toBeDefined();
    expect(nameFact?.fact_value).toContain('Илья');

    // project updated to "Orion Control Plane" by reseed
    const projectFact = facts.find((f) => f.fact_key === 'project');
    expect(projectFact).toBeDefined();
    expect(projectFact?.fact_value?.toLowerCase()).toContain('orion');

    // role updated to "platform engineer" by reseed
    const roleFact = facts.find((f) => f.fact_key === 'role');
    expect(roleFact).toBeDefined();

    // At least one goal fact
    const goalFact = facts.find((f) => f.fact_key === 'goal');
    expect(goalFact).toBeDefined();

    // Some episodic entries (corpus has decisions, tasks, constraints, etc.)
    expect(entries.length).toBeGreaterThan(0);

    // API and SQL facts must be consistent
    const apiFactKeys = userMem.userFacts.map((f) => f.key).sort();
    const sqlFactKeys = facts.map((f) => f.fact_key).sort();
    expect(apiFactKeys).toEqual(sqlFactKeys);

    // User and admin API must return same facts
    const adminFactKeys = adminMem.userFacts.map((f) => f.key).sort();
    expect(apiFactKeys).toEqual(adminFactKeys);

    // Suppressed facts from API must match SQL
    const apiSuppressed = (adminMem.suppressedFacts ?? []).map((s) => s.key).sort();
    const sqlSuppressed = suppressedFacts.map((s) => s.key).sort();
    expect(apiSuppressed).toEqual(sqlSuppressed);

    // After full reseed, name and project suppressions should be cleared
    // (because new facts for those keys were set, filtering them out of suppressedFacts)
    expect(suppressedFacts.find((s) => s.key === 'name')).toBeUndefined();
    expect(suppressedFacts.find((s) => s.key === 'project')).toBeUndefined();
  });
});
