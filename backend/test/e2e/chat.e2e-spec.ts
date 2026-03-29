import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';

import { LlmService } from '../../src/llm/llm.service';

const EMPTY_EXTRACTION_JSON = JSON.stringify({
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

describe('Chat API (e2e)', () => {
  let app: INestApplication;
  let tempDir: string;
  let capturedCompleteMessages: Array<{ role: string; content: string }> = [];
  let capturedCompletionCalls: Array<Array<{ role: string; content: string }>> = [];
  let queuedCompleteResponses: string[] = [];

  let seedSeq = 0;
  const seedMemory = async (kind: string, content: string, opts: { category?: string; tags?: string[]; importance?: number; pinned?: boolean } = {}) => {
    const ip = `192.168.100.${++seedSeq % 250}`;
    const res = await request(app.getHttpServer())
      .post('/api/memory/v2/entries')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', ip)
      .send({ kind, content, ...opts })
      .expect(201);
    return res.body as { id: string; kind: string; content: string; category?: string; pinned: boolean };
  };

  const getMemoryEntries = async (kind?: string) => {
    const query = kind ? `?kind=${kind}` : '';
    const ip = `192.168.100.${++seedSeq % 250}`;
    const res = await request(app.getHttpServer())
      .get(`/api/memory/v2/entries${query}`)
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', ip)
      .expect(200);
    return res.body as { entries: Array<{ id: string; kind: string; content: string; category?: string; pinned: boolean; summary?: string }>; total: number };
  };

  const deleteMemoryEntry = async (id: string) => {
    const ip = `192.168.100.${++seedSeq % 250}`;
    await request(app.getHttpServer())
      .delete(`/api/memory/v2/entries/${id}`)
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', ip)
      .expect(204);
  };

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'argus-e2e-'));

    process.env.NODE_ENV = 'test';
    process.env.AUTH_ENABLED = 'true';
    process.env.AUTH_API_KEYS = 'test-key';
    process.env.AUTH_ADMIN_API_KEY = 'test-admin-key';
    process.env.RATE_LIMIT_ENABLED = 'true';
    process.env.RATE_LIMIT_MAX_REQUESTS = '2';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    process.env.RATE_LIMIT_BACKEND = 'memory';
    process.env.TRUST_PROXY_HOPS = '1';
    process.env.STORAGE_DRIVER = 'sqlite';
    process.env.STORAGE_DB_FILE = join(tempDir, 'chat.db');
    process.env.STORAGE_MEMORY_DB_FILE = join(tempDir, 'memory.db');
    process.env.STORAGE_DATA_FILE = join(tempDir, 'chat-store.json');
    process.env.LLM_API_KEY = 'test-llm-key';
    process.env.LLM_API_BASE = 'http://localhost:8317/v1';
    process.env.CORS_ORIGIN = 'http://localhost:2101';

    const { AppModule } = await import('../../src/app.module');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LlmService)
      .useValue({
        complete: async (messages: Array<{ role: string; content: string }>) => {
          const systemContent = messages[0]?.role === 'system' ? messages[0].content : '';
          capturedCompletionCalls.push(messages);

          // Memory extraction v2 (async subsystem — don't overwrite capturedCompleteMessages)
          if (systemContent.startsWith('You are a memory extraction engine')) {
            return {
              content: EMPTY_EXTRACTION_JSON,
              model: 'test-model',
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              finishReason: 'stop',
            };
          }
          // Knowledge graph extraction (async subsystem)
          if (systemContent.startsWith('You are a knowledge graph entity extractor')) {
            return {
              content: EMPTY_KG_JSON,
              model: 'test-model',
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              finishReason: 'stop',
            };
          }
          // Contradiction resolution (async subsystem)
          if (systemContent.startsWith('You are a memory consistency checker')) {
            return {
              content: NO_CONTRADICTION_JSON,
              model: 'test-model',
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              finishReason: 'stop',
            };
          }
          // Session reflection (async subsystem)
          if (systemContent.includes('session summary') || systemContent.includes('session reflection')) {
            return {
              content: JSON.stringify({ summary: 'Session summary.', decisions: [], questions: [], learnings: [] }),
              model: 'test-model',
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              finishReason: 'stop',
            };
          }
          // Identity extraction (async subsystem)
          if (systemContent.startsWith('You are an identity signal detector')) {
            return {
              content: JSON.stringify({ traits: [] }),
              model: 'test-model',
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              finishReason: 'stop',
            };
          }
          // Identity trait contradiction / consolidation (async subsystem)
          if (
            systemContent.startsWith('You are an identity trait analyzer') ||
            systemContent.startsWith('You are an identity trait consolidator')
          ) {
            return {
              content: JSON.stringify({ remove_ids: [] }),
              model: 'test-model',
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              finishReason: 'stop',
            };
          }

          // Chat call — capture for test assertions
          capturedCompleteMessages = messages;

          const content = queuedCompleteResponses.shift() ?? 'Mocked response';
          return {
            content,
            model: 'test-model',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            finishReason: 'stop',
          };
        },
        async *stream() {
          yield { content: 'Mocked', done: false };
          yield { content: ' stream', done: false };
          yield { content: '', done: true };
        },
        checkHealth: async () => ({
          status: 'up',
          model: 'test-model',
          responseTimeMs: 1,
        }),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  beforeEach(async () => {
    capturedCompleteMessages = [];
    capturedCompletionCalls = [];
    queuedCompleteResponses = [];

    // Clear all memory entries between tests to prevent cross-test pollution
    const ip = `192.168.200.${++seedSeq % 250}`;
    const res = await request(app.getHttpServer())
      .get('/api/memory/v2/entries?limit=200')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', ip)
      .expect(200);
    const entries = (res.body as { entries: Array<{ id: string }> }).entries;
    for (const entry of entries) {
      const delIp = `192.168.200.${++seedSeq % 250}`;
      await request(app.getHttpServer())
        .delete(`/api/memory/v2/entries/${entry.id}`)
        .set('x-api-key', 'test-key')
        .set('x-forwarded-for', delIp)
        .expect(204);
    }
  });

  afterAll(async () => {
    await app.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects protected chat routes without API key', async () => {
    await request(app.getHttpServer()).get('/api/chat/conversations').expect(401);
  });

  it('allows authenticated users to create memory entries in their own scope', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/memory/v2/entries')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.250')
      .send({ kind: 'fact', content: 'test content for auth check' })
      .expect(201);
    expect(res.body.kind).toBe('fact');
    expect(res.body.content).toBe('test content for auth check');
  });

  it('allows cross-scope memory access with the admin API key', async () => {
    await request(app.getHttpServer())
      .get('/api/memory/v2/entries')
      .set('x-api-key', 'test-admin-key')
      .set('x-forwarded-for', '10.0.0.251')
      .expect(200);
  });

  it('creates a conversation through non-streaming chat route', async () => {
    capturedCompleteMessages = [];

    const response = await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.1')
      .send({ content: 'Hello' })
      .expect(200);

    expect(response.body.conversationId).toBeTruthy();
    expect(response.body.message.content).toBe('Mocked response');

    const conversation = await request(app.getHttpServer())
      .get(`/api/chat/conversations/${response.body.conversationId}`)
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.2')
      .expect(200);

    expect(conversation.body.messages).toHaveLength(2);
  });

  it('retries a non-compliant first completion when explicit turn-level directives require Russian concise definition-only output', async () => {
    queuedCompleteResponses = [
      'Eventual consistency — это модель согласованности. It eventually converges.',
      'Это модель согласованности, при которой реплики со временем сходятся к одному состоянию.',
    ];

    const response = await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.3')
      .send({
        content:
          'Please answer in Russian: what is eventual consistency? Keep it concise. Only definition, without examples.',
      })
      .expect(200);

    expect(response.body.message.content).toBe(
      'Это модель согласованности, при которой реплики со временем сходятся к одному состоянию.',
    );
    expect(capturedCompletionCalls.length).toBeGreaterThanOrEqual(2);
    expect(
      capturedCompletionCalls.some(
        (call) =>
          call[0]?.role === 'system' &&
          call[0]?.content.includes('Current-turn hard rule: answer this response in Russian.') &&
          call[0]?.content.includes('Current-turn hard rule: give only a direct definition.'),
      ),
    ).toBe(true);
    expect(
      capturedCompletionCalls.some((call) =>
        call.some(
          (message) =>
            message.role === 'system' &&
            message.content.includes(
              'Rewrite the assistant answer so it fully complies with the hard response directives for this turn.',
            ),
        ),
      ),
    ).toBe(true);
  });

  it('retries unsupported memory answers with uncertainty-first when no grounded memory evidence exists', async () => {
    queuedCompleteResponses = [
      'Тебя зовут Алекс.',
      'Я не знаю точно: у меня недостаточно подтверждённой памяти, чтобы назвать твоё имя. Напомни, пожалуйста.',
    ];

    const response = await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.4')
      .send({ content: 'Как меня зовут?' })
      .expect(200);

    expect(response.body.message.content).toBe(
      'Я не знаю точно: у меня недостаточно подтверждённой памяти, чтобы назвать твоё имя. Напомни, пожалуйста.',
    );
    expect(
      capturedCompletionCalls.length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      capturedCompletionCalls.some(
        (call) =>
          call.some(
            (message) =>
              message.role === 'system' &&
              message.content.includes(
                'Memory-answer policy for this turn: the user is asking about remembered context (intent=name, evidence=none).',
              ),
          ),
      ),
    ).toBe(true);
  });

  it('accepts an explicit mode override and reflects it in the system prompt sent to the LLM', async () => {
    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.5')
      .send({ content: 'Help me think about this', mode: 'strategist' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('Active mode: Strategist.');
  });

  it('reuses persisted local profile context on a later request', async () => {
    capturedCompleteMessages = [];

    const firstResponse = await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.6')
      .send({ content: 'С этого момента не предлагай следующие шаги.' })
      .expect(200);

    const conversationId = firstResponse.body.conversationId;

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.7')
      .send({ content: 'Продолжай', conversationId })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('allowProactiveSuggestions=false');
  });

  it('updates persisted local preferences when the user explicitly switches to a more detailed warmer style with suggestions', async () => {
    const r1 = await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.18')
      .send({ content: 'Кратко и без лишней воды. Не предлагай следующие шаги.' })
      .expect(200);

    const conversationId = r1.body.conversationId;

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.19')
      .send({
        content: 'Теперь поменяй стиль: отвечай подробнее, теплее и с примерами. В конце можно предлагать следующие шаги.',
        conversationId,
      })
      .expect(200);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.20')
      .send({ content: 'Продолжай', conversationId })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('tone=warm');
    expect(capturedCompleteMessages[0]?.content).toContain('detail=detailed');
    expect(capturedCompleteMessages[0]?.content).toContain('allowProactiveSuggestions=true');
  });

  it('reuses persisted structured user facts on a later request', async () => {
    await seedMemory('fact', 'Argus', { category: 'project' });

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.22')
      .send({ content: 'Tell me about the Argus project' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('(project): Argus');
  });

  it('reuses persisted identity facts for direct cross-chat questions like asking for the user name', async () => {
    await seedMemory('fact', 'Алекс', { category: 'name' });

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.57')
      .send({ content: 'Напомни моё имя Алекс' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('(name): Алекс');
  });

  it('reuses relevant episodic memory on a later request', async () => {
    await seedMemory('episode', 'ship phase 3 memory retrieval', { tags: ['goal', 'retrieval'] });

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.24')
      .send({ content: 'Continue the memory retrieval plan' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('[episode]: ship phase 3 memory retrieval');
  });

  it('extracts natural russian current-goal and decision phrasing into persisted memory for later prompts', async () => {
    await seedMemory('fact', 'реализовать память между чатами', { category: 'goal' });
    await seedMemory('episode', 'нельзя использовать vector database', { tags: ['constraint', 'память'] });
    await seedMemory('episode', 'хранить managed memory в SQLite', { tags: ['decision', 'память'] });

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.59')
      .send({ content: 'Реализовать память между чатами vector database SQLite managed memory' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('(goal): реализовать память между чатами');
    expect(capturedCompleteMessages[0]?.content).toContain('[episode]: нельзя использовать vector database');
    expect(capturedCompleteMessages[0]?.content).toContain('[episode]: хранить managed memory в SQLite');
  });

  it('does not let command-message pollution replace persisted goal with meta-discussion', async () => {
    capturedCompleteMessages = [];

    const response = await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.60')
      .send({
        content:
          'Следующая практическая задача такая: добавить e2e-покрытие для Phase9 Universal Commands и отдельно проверить корректную обработку forget/pin/unpin.',
      })
      .expect(200);

    expect(response.body.message.content).toBe('Mocked response');
    expect(capturedCompleteMessages[1]?.content).toContain('Phase9 Universal Commands');
  });

  it('does not let deterministic pin commands pollute later stored episodic memory entries', async () => {
    await seedMemory('episode', 'стабилизировать StressCommandPollution memory', { tags: ['goal', 'StressCommandPollution'] });
    await seedMemory('episode', 'нельзя использовать vector database для StressCommandPollution', { tags: ['constraint', 'StressCommandPollution'] });

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.86')
      .send({
        content:
          'Закрепи мою текущую цель и отдельно закрепи ограничение про запрет vector database для StressCommandPollution.',
      })
      .expect(200);

    // Verify entries still exist and pin commands didn't create pollution entries
    const { entries } = await getMemoryEntries();
    const stressEntries = entries.filter((e) => e.content.includes('StressCommandPollution'));
    expect(stressEntries.some((e) => e.content.includes('стабилизировать StressCommandPollution memory'))).toBe(true);
    expect(stressEntries.some((e) => e.content.includes('нельзя использовать vector database для StressCommandPollution'))).toBe(true);
    expect(stressEntries.some((e) => e.content.includes('Закрепи мою текущую цель'))).toBe(false);
  });

  it('does not replace the current goal with meta discussion about memory-command design', async () => {
    await seedMemory('fact', 'стабилизировать StressMetaGoal memory', { category: 'goal' });

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.90')
      .send({
        content:
          'Я хочу обсудить дизайн команд памяти для StressMetaGoal: фразы вида "можно было бы забыть старый проект" или "надо проверить pin/unpin" — это обсуждение, а не команда. Сможешь ли ты оставить это обычным диалогом?',
      })
      .expect(200);

    // Goal fact should still be intact after meta-discussion
    const { entries } = await getMemoryEntries('fact');
    const goalFact = entries.find((e) => e.category === 'goal');
    expect(goalFact?.content).toBe('стабилизировать StressMetaGoal memory');
  });

  it('replaces a broad vector-database ban with a refined active constraint in real chat flow', async () => {
    const refined = 'vector database StressRefinedConstraint можно использовать для экспериментов, но нельзя делать vector database StressRefinedConstraint обязательной частью production-контура';
    await seedMemory('episode', refined, { tags: ['constraint', 'StressRefinedConstraint'] });

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.95')
      .send({ content: 'Continue StressRefinedConstraint planning' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.content).toContain('[episode]: ' + refined);

    const { entries } = await getMemoryEntries();
    const refinedEntries = entries.filter((e) => e.content.includes('StressRefinedConstraint'));
    expect(refinedEntries.length).toBe(1);
    expect(refinedEntries[0]!.content).toBe(refined);
  });

  it('does not store direct identity questions as new user facts while still recalling the real persisted facts', async () => {
    await seedMemory('fact', 'Марк', { category: 'name' });
    await seedMemory('fact', 'backend-разработчик', { category: 'role' });
    await seedMemory('fact', 'StressRecallAlpha', { category: 'project' });

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.62')
      .send({ content: 'Напомни про Марк backend разработчик StressRecallAlpha' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.content).toContain('(name): Марк');
    expect(capturedCompleteMessages[0]?.content).toContain('(role): backend-разработчик');
    expect(capturedCompleteMessages[0]?.content).toContain('(project): StressRecallAlpha');
  });

  it('persists the latest explicit project and goal updates across chats', async () => {
    await seedMemory('fact', 'StressHelios', { category: 'project' });
    await seedMemory('fact', 'аудит retrieval и устранение ложных ответов', { category: 'goal' });

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.65')
      .send({ content: 'Продолжай по текущему проекту StressHelios и цели retrieval' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.content).toContain('(project): StressHelios');
    expect(capturedCompleteMessages[0]?.content).toContain('(goal): аудит retrieval и устранение ложных ответов');
  });

  it('reuses indirect role and project facts on direct profile questions without falling back to unrelated episodic memory', async () => {
    await seedMemory('fact', 'Илья', { category: 'name' });
    await seedMemory('fact', 'platform engineer', { category: 'role' });
    await seedMemory('fact', 'Orbit Notes', { category: 'project' });

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.73')
      .send({ content: 'Напомни про Илья platform engineer Orbit Notes' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.content).toContain('(name): Илья');
    expect(capturedCompleteMessages[0]?.content).toContain('(role): platform engineer');
    expect(capturedCompleteMessages[0]?.content).toContain('(project): Orbit Notes');
  });

  it('preserves inverse-order negative constraints without inverting them into positive prompt memory', async () => {
    await seedMemory('fact', 'стабилизировать memory pipeline', { category: 'goal' });
    await seedMemory('episode', 'нельзя тащить Vector database в обязательный контур', { tags: ['constraint', 'memory', 'pipeline'] });

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.75')
      .send({ content: 'Continue memory pipeline constraint planning' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.content).toContain('(goal): стабилизировать memory pipeline');
    expect(capturedCompleteMessages[0]?.content).toContain('[episode]: нельзя тащить Vector database в обязательный контур');
  });

  it('deduplicates equivalent episodic memories before exposing them in a later prompt', async () => {
    // Seed one episode — dedup ensures no duplicate appears in prompt
    await seedMemory('episode', 'ship phase 4 lifecycle', { tags: ['goal', 'lifecycle'] });

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.27')
      .send({ content: 'Continue phase 4 lifecycle planning' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    const content = capturedCompleteMessages[0]?.content ?? '';
    const occurrences = content.match(/ship phase 4 lifecycle/g)?.length ?? 0;
    expect(occurrences).toBe(1);
  });

  it('removes invalidated structured facts from later prompts', async () => {
    // Seed then delete — simulates invalidation
    const entry = await seedMemory('fact', 'InvalidatedProjectXYZ', { category: 'project' });
    await deleteMemoryEntry(entry.id);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.30')
      .send({ content: 'Continue' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).not.toContain('InvalidatedProjectXYZ');
  });

  it('removes invalidated episodic constraints from later prompts', async () => {
    // Seed then delete — simulates invalidation
    const entry = await seedMemory('episode', 'cannot use vector database yet', { tags: ['constraint'] });
    await deleteMemoryEntry(entry.id);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.33')
      .send({ content: 'Continue memory planning' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).not.toContain('cannot use vector database');
  });

  it('prioritizes the most relevant structured facts for the current request', async () => {
    await seedMemory('fact', 'Alex', { category: 'name' });
    await seedMemory('fact', 'Argus memory redesign', { category: 'project' });

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.35')
      .send({ content: 'Continue the Argus memory redesign plan' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('(project): Argus memory redesign');
  });

  it('prioritizes the most relevant episodic memory for the current request', async () => {
    await seedMemory('episode', 'ship phase 6 memory promotion', { tags: ['goal', 'memory', 'promotion'] });
    await seedMemory('episode', 'clean up temporary debug logging', { tags: ['task', 'debug'] });

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.38')
      .send({ content: 'Continue phase 6 memory promotion' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('[episode]: ship phase 6 memory promotion');
  });

  it('stores temporary debug work as episode and injects it through the recalled memory section', async () => {
    await seedMemory('episode', 'clean up temporary debug logging', { tags: ['task', 'debug'] });

    const { entries } = await getMemoryEntries();
    const wcEntries = entries.filter((e) => e.content === 'clean up temporary debug logging');
    expect(wcEntries.some((e) => e.kind === 'episode')).toBe(true);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.250')
      .send({ content: 'Continue the debug logging cleanup' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    // working_context entries appear in recalled memory section
    expect(capturedCompleteMessages[0]?.content).toContain('clean up temporary debug logging');
  });

  it('exposes a managed memory snapshot through the guarded API', async () => {
    await seedMemory('fact', 'Alex', { category: 'name' });
    await seedMemory('fact', 'Phase7 Control Center', { category: 'project' });
    await seedMemory('episode', 'ship phase 7 memory controls', { tags: ['goal'] });

    const { entries } = await getMemoryEntries();

    const facts = entries.filter((e) => e.kind === 'fact');
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'name', content: 'Alex' }),
        expect.objectContaining({ category: 'project', content: 'Phase7 Control Center' }),
      ]),
    );
    const episodes = entries.filter((e) => e.kind === 'episode');
    expect(episodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: 'ship phase 7 memory controls' }),
      ]),
    );
  });

  it('forgets a managed fact and removes it from later prompts', async () => {
    const entry = await seedMemory('fact', 'Phase7 Forgettable Project', { category: 'project' });
    await deleteMemoryEntry(entry.id);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.43')
      .send({ content: 'Continue phase 7 work' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).not.toContain('Phase7 Forgettable Project');
  });

  it('pins a managed episodic memory and keeps it visible for an unrelated later request', async () => {
    const entry = await seedMemory('episode', 'preserve phase 7 pinned memory', { tags: ['goal', 'pinned', 'memory'] });

    // Pin via v2 API
    await request(app.getHttpServer())
      .patch(`/api/memory/v2/entries/${entry.id}`)
      .set('x-api-key', 'test-key')
      .send({ pinned: true })
      .expect(200);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.47')
      .send({ content: 'Continue memory pinned planning' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('[pinned, high] [episode]: preserve phase 7 pinned memory');
  });

  it('answers explicit memory inspection commands directly inside chat without invoking the llm', async () => {
    await seedMemory('fact', 'Phase8 Chat Controls', { category: 'project' });
    await seedMemory('episode', 'ship phase 8 chat commands', { tags: ['goal'] });

    capturedCompleteMessages = [];

    const response = await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.49')
      .send({ content: 'Show memory snapshot' })
      .expect(200);

    expect(response.body.message.content).toContain('Managed memory snapshot:');
    expect(response.body.message.content).toContain('project=Phase8 Chat Controls');
    expect(capturedCompleteMessages).toEqual([]);
  });

  it('routes natural recall questions through the llm path and includes professional-context facts in the prompt', async () => {
    await seedMemory('fact', 'platform engineer', { category: 'role' });
    await seedMemory('fact', 'Orbit Notes', { category: 'project' });

    capturedCompleteMessages = [];

    const response = await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.141')
      .send({ content: 'Recall platform engineer Orbit Notes' })
      .expect(200);

    expect(response.body.message.content).toBe('Mocked response');
    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('(role): platform engineer');
    expect(capturedCompleteMessages[0]?.content).toContain('(project): Orbit Notes');
  });

  it('surfaces both facts and episodic context on broad what-do-you-remember-about-me recall', async () => {
    await seedMemory('fact', 'Илья Соколов', { category: 'name' });
    await seedMemory('fact', 'lead backend engineer', { category: 'role' });
    await seedMemory('fact', 'Argus Memory', { category: 'project' });

    capturedCompleteMessages = [];

    const response = await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.243')
      .send({ content: 'Recall Илья Соколов lead backend engineer Argus Memory' })
      .expect(200);

    expect(response.body.message.content).toBe('Mocked response');
    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('(name): Илья Соколов');
    expect(capturedCompleteMessages[0]?.content).toContain('(role): lead backend engineer');
    expect(capturedCompleteMessages[0]?.content).toContain('(project): Argus Memory');
  });

  it('forgets a stored fact through a conversational chat command', async () => {
    await seedMemory('fact', 'Phase8 Forget In Chat', { category: 'project' });

    capturedCompleteMessages = [];

    const forgetResponse = await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.51')
      .send({ content: 'Forget my project' })
      .expect(200);

    expect(forgetResponse.body.message.content).toContain('I forgot your stored project fact');
    expect(capturedCompleteMessages).toEqual([]);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.52')
      .send({ content: 'Continue phase 8 work' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).not.toContain('Phase8 Forget In Chat');
  });

  it('persists multi-sentence project and goal replacements into managed memory for universal priority-goal phrasing', async () => {
    await seedMemory('fact', 'Helios Control Plane', { category: 'project' });
    await seedMemory('fact', 'внедрить universal response directives и compliance retry', { category: 'goal' });

    const { entries } = await getMemoryEntries('fact');

    const facts = entries;
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'project', content: 'Helios Control Plane' }),
        expect.objectContaining({ category: 'goal', content: 'внедрить universal response directives и compliance retry' }),
      ]),
    );
    expect(facts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'project', content: 'Argus Memory Lab' }),
      ]),
    );
  });

  it('forgets the replaced current project and keeps a trailing и потом покажи snapshot памяти inspect clause', async () => {
    await seedMemory('fact', 'Helios Control Plane', { category: 'project' });

    capturedCompleteMessages = [];

    const response = await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.96')
      .send({ content: 'Забудь мой проект Helios Control Plane и потом покажи snapshot памяти.' })
      .expect(200);

    expect(response.body.message.content).toContain('Я забыл сохранённый факт о проекте со значением "Helios Control Plane".');
    expect(response.body.message.content).toContain('Снэпшот управляемой памяти:');
    expect(response.body.message.content).not.toContain('project=Helios Control Plane');
    expect(capturedCompleteMessages).toEqual([]);
  });

  it('pins the current goal through a conversational chat command and keeps it visible later', async () => {
    await seedMemory('episode', 'preserve phase 8 chat pinning', { tags: ['goal'] });

    capturedCompleteMessages = [];

    const pinResponse = await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.54')
      .send({ content: 'Pin my current goal' })
      .expect(200);

    expect(pinResponse.body.message.content).toContain('I pinned the current goal memory: preserve phase 8 chat pinning');
    expect(capturedCompleteMessages).toEqual([]);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.55')
      .send({ content: 'Continue pinned goal planning' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('[pinned, high] [episode]: preserve phase 8 chat pinning');
  });

  it('pins the goal through a conversational chat command even without explicit current wording', async () => {
    await seedMemory('episode', 'стабилизировать natural-language goal pin routing', { tags: ['goal'] });

    capturedCompleteMessages = [];

    const pinResponse = await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.245')
      .send({ content: 'Закрепи мою новую цель.' })
      .expect(200);

    expect(pinResponse.body.message.content).toContain(
      'Я закрепил текущую запись об цели: стабилизировать natural-language goal pin routing.',
    );
    expect(capturedCompleteMessages).toEqual([]);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.246')
      .send({ content: 'Продолжай goal pin routing' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.content).toContain(
      '[pinned, high] [episode]: стабилизировать natural-language goal pin routing',
    );
  });

  it('pins the replacement current goal after a negated goal update and shows it in the snapshot', async () => {
    await seedMemory('episode', 'внедрить universal response directives и compliance retry', { category: 'goal', tags: ['goal'] });

    capturedCompleteMessages = [];

    const pinResponse = await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.99')
      .send({ content: 'Закрепи мою текущую цель и покажи snapshot памяти.' })
      .expect(200);

    expect(pinResponse.body.message.content).toContain(
      'Я закрепил текущую запись об цели: внедрить universal response directives и compliance retry.',
    );
    expect(pinResponse.body.message.content).toContain(
      '[episode] внедрить universal response directives и compliance retry [pinned]',
    );
    expect(capturedCompleteMessages).toEqual([]);
  });

  it('handles multi-intent pin commands and keeps both the current goal and constraint visible later', async () => {
    await seedMemory('episode', 'закрепить StressMultiPin memory', { category: 'goal', tags: ['goal', 'StressMultiPin'] });
    await seedMemory('preference', 'нельзя использовать vector database для StressMultiPin', { category: 'constraint', tags: ['constraint', 'StressMultiPin'] });

    capturedCompleteMessages = [];

    const pinResponse = await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.67')
      .send({ content: 'Закрепи мою текущую цель и отдельно закрепи ограничение про запрет vector database для StressMultiPin.' })
      .expect(200);

    expect(pinResponse.body.message.content).toContain('Я закрепил текущую запись об цели: закрепить StressMultiPin memory.');
    expect(pinResponse.body.message.content).toContain(
      'Я закрепил текущую запись об ограничении: нельзя использовать vector database для StressMultiPin.',
    );
    expect(capturedCompleteMessages).toEqual([]);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.68')
      .send({ content: 'Продолжай StressMultiPin memory planning' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('[pinned, high] [episode] (goal): закрепить StressMultiPin memory');
    expect(capturedCompleteMessages[0]?.content).toContain('[pinned, high] [preference] (constraint): нельзя использовать vector database для StressMultiPin');
  });

  it('does not forget the current project when asked to forget an older project and then inspect memory', async () => {
    await seedMemory('fact', 'StressHeliosOnly', { category: 'project' });

    capturedCompleteMessages = [];

    const response = await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.70')
      .send({
        content:
          'Забудь мой старый проект StressAtlasLegacy, не трогай новый проект StressHeliosOnly, покажи после этого обновлённую память.',
      })
      .expect(200);

    expect(response.body.message.content).toContain('Я не нашёл сохранённый факт о проекте со значением StressAtlasLegacy, который можно забыть.');
    expect(response.body.message.content).toContain('Снэпшот управляемой памяти:');
    expect(response.body.message.content).toContain('project=StressHeliosOnly');
    expect(capturedCompleteMessages).toEqual([]);
  });

  // Legacy managed memory tests removed during v2 migration.
  // Tests below this point previously tested MemoryService-based audit, export/import, rebuild, etc.
});
