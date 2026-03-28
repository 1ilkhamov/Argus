import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';

import { deriveScopeKey } from '../src/common/auth/scope-key';
import { LlmService } from '../src/llm/llm.service';

const TEST_USER_SCOPE_KEY = deriveScopeKey('test-key');
const EMPTY_EXTRACTION_JSON = JSON.stringify({
  facts: [],
  episodes: [],
  invalidatedFactKeys: [],
  invalidatedEpisodeKinds: [],
});

describe('Chat API (e2e)', () => {
  let app: INestApplication;
  let tempDir: string;
  let capturedCompleteMessages: Array<{ role: string; content: string }> = [];
  let capturedCompletionCalls: Array<Array<{ role: string; content: string }>> = [];
  let queuedCompleteResponses: string[] = [];

  const adminGet = (path: string, scopeKey?: string) => {
    const req = request(app.getHttpServer()).get(path).set('x-api-key', 'test-admin-key');
    return scopeKey ? req.query({ scopeKey }) : req;
  };

  const adminPost = (path: string, scopeKey?: string) => {
    const req = request(app.getHttpServer()).post(path).set('x-api-key', 'test-admin-key');
    return scopeKey ? req.query({ scopeKey }) : req;
  };

  const adminDelete = (path: string, scopeKey?: string) => {
    const req = request(app.getHttpServer()).delete(path).set('x-api-key', 'test-admin-key');
    return scopeKey ? req.query({ scopeKey }) : req;
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

    const { AppModule } = await import('../src/app.module');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LlmService)
      .useValue({
        complete: async (messages: Array<{ role: string; content: string }>) => {
          const systemContent = messages[0]?.role === 'system' ? messages[0].content : '';
          capturedCompleteMessages = messages;
          capturedCompletionCalls.push(messages);

          if (systemContent.startsWith('You are a structured memory extractor')) {
            return {
              content: EMPTY_EXTRACTION_JSON,
              model: 'test-model',
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              finishReason: 'stop',
            };
          }

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

  beforeEach(() => {
    capturedCompleteMessages = [];
    capturedCompletionCalls = [];
    queuedCompleteResponses = [];
  });

  afterAll(async () => {
    await app.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects protected chat routes without API key', async () => {
    await request(app.getHttpServer()).get('/api/chat/conversations').expect(401);
  });

  it('rejects cross-scope memory access with a regular (non-admin) API key', async () => {
    await request(app.getHttpServer())
      .get('/api/chat/memory')
      .query({ scopeKey: TEST_USER_SCOPE_KEY })
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.250')
      .expect(401);
  });

  it('allows cross-scope memory access with the admin API key', async () => {
    await request(app.getHttpServer())
      .get('/api/chat/memory')
      .query({ scopeKey: TEST_USER_SCOPE_KEY })
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

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.6')
      .send({ content: 'С этого момента не предлагай следующие шаги.' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.7')
      .send({ content: 'Продолжай' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('allowProactiveSuggestions=false');
    expect(capturedCompleteMessages[0]?.content).toContain(
      'Current user profile note: these preferences are resolved from stored profile context plus recent conversation cues for this response.',
    );
  });

  it('updates persisted local preferences when the user explicitly switches to a more detailed warmer style with suggestions', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.18')
      .send({ content: 'Кратко и без лишней воды. Не предлагай следующие шаги.' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.19')
      .send({
        content: 'Теперь поменяй стиль: отвечай подробнее, теплее и с примерами. В конце можно предлагать следующие шаги.',
      })
      .expect(200);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.20')
      .send({ content: 'Продолжай' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('tone=warm');
    expect(capturedCompleteMessages[0]?.content).toContain('detail=detailed');
    expect(capturedCompleteMessages[0]?.content).toContain('allowProactiveSuggestions=true');
    expect(capturedCompleteMessages[0]?.content).toContain(
      'Current user profile note: these preferences are resolved from stored profile context plus recent conversation cues for this response.',
    );
  });

  it('reuses persisted structured user facts on a later request', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.21')
      .send({ content: 'Меня зовут Alex. Я работаю над Argus.' })
      .expect(200);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.22')
      .send({ content: 'Продолжай' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('project=Argus');
  });

  it('reuses persisted identity facts for direct cross-chat questions like asking for the user name', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.56')
      .send({ content: 'Меня зовут Алекс.' })
      .expect(200);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.57')
      .send({ content: 'Как меня зовут?' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('Known user facts: name=Алекс');
  });

  it('reuses relevant episodic memory on a later request', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.23')
      .send({ content: 'Моя цель — ship phase 3 memory retrieval. Мы не можем использовать vector database.' })
      .expect(200);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.24')
      .send({ content: 'Продолжай про retrieval' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('Relevant conversation memory: goal=ship phase 3 memory retrieval');
  });

  it('extracts natural russian current-goal and decision phrasing into persisted memory for later prompts', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.58')
      .send({
        content:
          'Моя текущая цель — реализовать память между чатами. У нас есть ограничение: нельзя использовать vector database. Мы приняли решение хранить managed memory в SQLite.',
      })
      .expect(200);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.59')
      .send({ content: 'Продолжай план памяти между чатами' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('Known user facts: goal=реализовать память между чатами');
    expect(capturedCompleteMessages[0]?.content).toContain('Relevant conversation memory: goal=реализовать память между чатами');
    expect(capturedCompleteMessages[0]?.content).toContain('constraint=нельзя использовать vector database');
    expect(capturedCompleteMessages[0]?.content).toMatch(/decision=(?:хранить managed memory в SQLite|на SQLite)/);
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
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.85')
      .send({
        content:
          'Моя текущая цель — стабилизировать StressCommandPollution memory. У нас есть ограничение: нельзя использовать vector database для StressCommandPollution.',
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.86')
      .send({
        content:
          'Закрепи мою текущую цель и отдельно закрепи ограничение про запрет vector database для StressCommandPollution.',
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.87')
      .send({ content: 'Продолжай StressCommandPollution' })
      .expect(200);

    const snapshot = await adminGet('/api/chat/memory', TEST_USER_SCOPE_KEY)
      .set('x-forwarded-for', '10.0.0.88')
      .expect(200);

    const stressEntries = snapshot.body.episodicMemories.filter((entry: { summary?: string }) =>
      entry.summary?.includes('StressCommandPollution'),
    );
    expect(stressEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'goal', summary: 'стабилизировать StressCommandPollution memory' }),
        expect.objectContaining({ kind: 'constraint', summary: 'нельзя использовать vector database для StressCommandPollution' }),
      ]),
    );
    expect(stressEntries.some((entry: { summary?: string }) => entry.summary?.includes('Закрепи мою текущую цель'))).toBe(false);
    expect(stressEntries.some((entry: { summary?: string }) => entry.summary === 'использовать vector database')).toBe(false);
  });

  it('does not replace the current goal with meta discussion about memory-command design', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.89')
      .send({ content: 'Моя текущая цель — стабилизировать StressMetaGoal memory.' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.90')
      .send({
        content:
          'Я хочу обсудить дизайн команд памяти для StressMetaGoal: фразы вида “можно было бы забыть старый проект” или “надо проверить pin/unpin” — это обсуждение, а не команда. Сможешь ли ты оставить это обычным диалогом?',
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.91')
      .send({ content: 'Продолжай StressMetaGoal' })
      .expect(200);

    const snapshot = await adminGet('/api/chat/memory', TEST_USER_SCOPE_KEY)
      .set('x-forwarded-for', '10.0.0.92')
      .expect(200);

    expect(snapshot.body.userFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'goal', value: 'стабилизировать StressMetaGoal memory' }),
      ]),
    );
    expect(
      snapshot.body.userFacts.some(
        (fact: { key?: string; value?: string }) => fact.key === 'goal' && fact.value?.includes('дизайн команд памяти'),
      ),
    ).toBe(false);
  });

  it('replaces a broad vector-database ban with a refined active constraint in real chat flow', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.93')
      .send({ content: 'Vector database StressRefinedConstraint в обязательный контур тащить нельзя.' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.94')
      .send({
        content:
          'Использовать vector database StressRefinedConstraint уже можно для экспериментов, но нельзя делать его обязательной частью production-контура.',
      })
      .expect(200);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.95')
      .send({ content: 'Продолжай StressRefinedConstraint' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.content).toContain(
      'constraint=vector database StressRefinedConstraint можно использовать для экспериментов, но нельзя делать vector database StressRefinedConstraint обязательной частью production-контура',
    );
    expect(capturedCompleteMessages[0]?.content).not.toContain(
      'constraint=нельзя тащить Vector database StressRefinedConstraint в обязательный контур',
    );

    const snapshot = await adminGet('/api/chat/memory', TEST_USER_SCOPE_KEY)
      .set('x-forwarded-for', '10.0.0.96')
      .expect(200);

    const refinedEntries = snapshot.body.episodicMemories.filter((entry: { summary?: string }) =>
      entry.summary?.includes('StressRefinedConstraint'),
    );
    expect(refinedEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'constraint',
          summary:
            'vector database StressRefinedConstraint можно использовать для экспериментов, но нельзя делать vector database StressRefinedConstraint обязательной частью production-контура',
        }),
      ]),
    );
    expect(
      refinedEntries.some((entry: { summary?: string }) =>
        entry.summary?.includes('тащить') && entry.summary?.includes('StressRefinedConstraint'),
      ),
    ).toBe(false);
  });

  it('does not store direct identity questions as new user facts while still recalling the real persisted facts', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.61')
      .send({ content: 'Меня зовут Марк. Я backend-разработчик. Я работаю над проектом StressRecallAlpha.' })
      .expect(200);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.62')
      .send({ content: 'Напомни, пожалуйста, кто я в рабочем контексте, как меня зовут и над чем я вообще сейчас работаю.' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.content).toContain('name=Марк');
    expect(capturedCompleteMessages[0]?.content).toContain('role=backend-разработчик');
    expect(capturedCompleteMessages[0]?.content).toContain('project=StressRecallAlpha');
    expect(capturedCompleteMessages[0]?.content).not.toContain('name=и над чем я вообще сейчас работаю');
  });

  it('persists the latest explicit project and goal updates across chats', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.63')
      .send({
        content:
          'Я работаю над проектом StressAtlas. Моя текущая цель — сделать память между чатами действительно надёжной.',
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.64')
      .send({
        content:
          'Теперь мой текущий проект StressHelios, но роль у меня прежняя. Теперь мой главный фокус аудит retrieval и устранение ложных ответов.',
      })
      .expect(200);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.65')
      .send({ content: 'Продолжай по текущему проекту и цели' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.content).toContain('project=StressHelios');
    expect(capturedCompleteMessages[0]?.content).not.toContain('project=StressAtlas');
    expect(capturedCompleteMessages[0]?.content).toContain('goal=аудит retrieval и устранение ложных ответов');
  });

  it('reuses indirect role and project facts on direct profile questions without falling back to unrelated episodic memory', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.71')
      .send({
        content:
          'Меня зовут Илья. По роли я скорее platform engineer. Сейчас основной рабочий проект у меня Nebula Desk. Managed memory пока оставляем на SQLite. Vector database в обязательный контур тащить нельзя.',
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.72')
      .send({ content: 'Проект у меня уже не Nebula Desk, а Orbit Notes.' })
      .expect(200);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.73')
      .send({ content: 'После паузы напомни мне коротко: кто я по роли, как меня зовут и какой у меня текущий проект?' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.content).toContain('name=Илья');
    expect(capturedCompleteMessages[0]?.content).toContain('role=platform engineer');
    expect(capturedCompleteMessages[0]?.content).toContain('project=Orbit Notes');
    expect(capturedCompleteMessages[0]?.content).not.toContain('project=Nebula Desk');
    expect(capturedCompleteMessages[0]?.content).not.toContain('constraint=нельзя тащить vector database в обязательный контур');
    expect(capturedCompleteMessages[0]?.content).not.toContain('decision=на SQLite');
  });

  it('preserves inverse-order negative constraints without inverting them into positive prompt memory', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.74')
      .send({
        content:
          'Моя текущая цель — стабилизировать memory pipeline. Vector database в обязательный контур тащить нельзя. Managed memory пока оставляем на SQLite.',
      })
      .expect(200);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.75')
      .send({ content: 'Продолжай memory pipeline' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.content).toContain('goal=стабилизировать memory pipeline');
    expect(capturedCompleteMessages[0]?.content).toContain('constraint=нельзя тащить Vector database в обязательный контур');
    expect(capturedCompleteMessages[0]?.content).not.toContain('constraint=использовать vector database');
    expect(capturedCompleteMessages[0]?.content).not.toContain('constraint=cannot use SQLite');
  });

  it('deduplicates equivalent episodic memories before exposing them in a later prompt', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.25')
      .send({ content: 'My goal is ship phase 4 lifecycle.' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.26')
      .send({ content: 'My goal is  ship phase 4 lifecycle  .' })
      .expect(200);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.27')
      .send({ content: 'Continue phase 4 lifecycle planning' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    const episodicSection =
      capturedCompleteMessages[0]?.content.match(/Relevant conversation memory:([^.]*)\./)?.[1] ?? '';
    const memoryOccurrences = episodicSection.match(/goal=ship phase 4 lifecycle/g)?.length ?? 0;
    expect(memoryOccurrences).toBe(1);
  });

  it('removes invalidated structured facts from later prompts', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.28')
      .send({ content: 'I am working on Argus.' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.29')
      .send({ content: 'I am no longer working on Argus.' })
      .expect(200);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.30')
      .send({ content: 'Continue' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).not.toContain('project=Argus');
  });

  it('removes invalidated episodic constraints from later prompts', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.31')
      .send({ content: 'We cannot use vector database yet.' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.32')
      .send({ content: 'We can use vector database now.' })
      .expect(200);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.33')
      .send({ content: 'Continue memory planning' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).not.toContain('constraint=use vector database now');
    expect(capturedCompleteMessages[0]?.content).not.toContain('constraint=vector database');
  });

  it('prioritizes the most relevant structured facts for the current request', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.34')
      .send({ content: 'My name is Alex. I am working on Argus memory redesign.' })
      .expect(200);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.35')
      .send({ content: 'Continue the Argus memory redesign plan' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('project=Argus memory redesign');
    expect(capturedCompleteMessages[0]?.content).not.toContain('name=Alex');
  });

  it('prioritizes the most relevant episodic memory for the current request', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.36')
      .send({ content: 'My goal is ship phase 6 memory promotion.' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.37')
      .send({ content: 'Todo: clean up temporary debug logging.' })
      .expect(200);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.38')
      .send({ content: 'Continue phase 6 memory promotion' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('Relevant conversation memory: goal=ship phase 6 memory promotion');
    expect(capturedCompleteMessages[0]?.content).not.toContain('task=clean up temporary debug logging');
  });

  it('stores temporary debug work as working_context and injects it through the dedicated prompt section', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.248')
      .send({ content: 'Todo: clean up temporary debug logging.' })
      .expect(200);

    const snapshot = await adminGet('/api/chat/memory', TEST_USER_SCOPE_KEY)
      .set('x-forwarded-for', '10.0.0.249')
      .expect(200);

    expect(snapshot.body.episodicMemories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'working_context', summary: 'clean up temporary debug logging' }),
      ]),
    );
    expect(snapshot.body.episodicMemories).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'task', summary: 'clean up temporary debug logging' }),
      ]),
    );

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.250')
      .send({ content: 'Continue the debug logging cleanup' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain(
      'Current working context from recent conversation: clean up temporary debug logging.',
    );
    expect(capturedCompleteMessages[0]?.content).not.toContain(
      'Relevant conversation memory: task=clean up temporary debug logging',
    );
  });

  it('exposes a managed memory snapshot through the guarded API', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.39')
      .send({ content: 'My name is Alex. I am working on Phase7 Control Center. My goal is ship phase 7 memory controls.' })
      .expect(200);

    const response = await adminGet('/api/chat/memory', TEST_USER_SCOPE_KEY)
      .set('x-forwarded-for', '10.0.0.40')
      .expect(200);

    expect(response.body.scopeKey).toBe(TEST_USER_SCOPE_KEY);
    expect(response.body.userFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'name', value: 'Alex' }),
        expect.objectContaining({ key: 'project', value: 'Phase7 Control Center' }),
        expect.objectContaining({ key: 'goal', value: 'ship phase 7 memory controls' }),
      ]),
    );
    expect(response.body.episodicMemories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'goal', summary: 'ship phase 7 memory controls' }),
      ]),
    );
  });

  it('forgets a managed fact and removes it from later prompts', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.41')
      .send({ content: 'I am working on Phase7 Forgettable Project.' })
      .expect(200);

    await adminDelete('/api/chat/memory/facts/project', TEST_USER_SCOPE_KEY)
      .set('x-forwarded-for', '10.0.0.42')
      .expect(204);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.43')
      .send({ content: 'Continue phase 7 work' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).not.toContain('project=Phase7 Forgettable Project');
  });

  it('pins a managed episodic memory and keeps it visible for an unrelated later request', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.44')
      .send({ content: 'My goal is preserve phase 7 pinned memory.' })
      .expect(200);

    const snapshot = await adminGet('/api/chat/memory', TEST_USER_SCOPE_KEY)
      .set('x-forwarded-for', '10.0.0.45')
      .expect(200);

    const pinnedEntry = snapshot.body.episodicMemories.find(
      (entry: { kind?: string; summary?: string; id?: string }) =>
        entry.kind === 'goal' && entry.summary === 'preserve phase 7 pinned memory',
    );
    expect(pinnedEntry?.id).toBeTruthy();

    await adminPost(`/api/chat/memory/episodic/${pinnedEntry.id}/pin`, TEST_USER_SCOPE_KEY)
      .set('x-forwarded-for', '10.0.0.46')
      .send({ pinned: true })
      .expect(201);

    capturedCompleteMessages = [];

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.47')
      .send({ content: 'Continue' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('goal=preserve phase 7 pinned memory');
  });

  it('answers explicit memory inspection commands directly inside chat without invoking the llm', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.48')
      .send({ content: 'My name is Alex. I am working on Phase8 Chat Controls. My goal is ship phase 8 chat commands.' })
      .expect(200);

    capturedCompleteMessages = [];

    const response = await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.49')
      .send({ content: 'Show memory snapshot' })
      .expect(200);

    expect(response.body.message.content).toContain('Managed memory snapshot:');
    expect(response.body.message.content).toContain('project=Phase8 Chat Controls');
    expect(response.body.message.content).toContain('goal=ship phase 8 chat commands');
    expect(capturedCompleteMessages).toEqual([]);
  });

  it('routes natural recall questions through the llm path and includes professional-context facts in the prompt', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.140')
      .send({ content: 'По роли я скорее platform engineer, а мой основной рабочий проект — Orbit Notes.' })
      .expect(200);

    capturedCompleteMessages = [];

    const response = await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.141')
      .send({ content: 'Что ты помнишь обо мне как о специалисте и над чем я работаю?' })
      .expect(200);

    expect(response.body.message.content).toBe('Mocked response');
    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('Known user facts:');
    expect(capturedCompleteMessages[0]?.content).toContain('role=platform engineer');
    expect(capturedCompleteMessages[0]?.content).toContain('project=Orbit Notes');
  });

  it('surfaces both facts and episodic context on broad what-do-you-remember-about-me recall', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.240')
      .send({
        content:
          'Меня зовут Илья Соколов. Я lead backend engineer. Сейчас мой основной проект — Argus Memory, а главная цель на ближайшее время — закрыть production hardening и потом сделать folder refactor без регрессий.',
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.241')
      .send({ content: 'Vector database в обязательный контур тащить нельзя.' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.242')
      .send({
        content:
          'Обновляю цель: теперь моя цель — полностью проверить всю реализацию папки memory end-to-end и подготовить regression checklist для API.',
      })
      .expect(200);

    capturedCompleteMessages = [];

    const response = await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.243')
      .send({ content: 'Покажи, что ты сейчас помнишь обо мне.' })
      .expect(200);

    expect(response.body.message.content).toBe('Mocked response');
    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('Known user facts:');
    expect(capturedCompleteMessages[0]?.content).toContain('name=Илья Соколов');
    expect(capturedCompleteMessages[0]?.content).toContain('role=lead backend engineer');
    expect(capturedCompleteMessages[0]?.content).toContain('project=Argus Memory');
  });

  it('forgets a stored fact through a conversational chat command', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.50')
      .send({ content: 'I am working on Phase8 Forget In Chat.' })
      .expect(200);

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
    expect(capturedCompleteMessages[0]?.content).not.toContain('project=Phase8 Forget In Chat');
  });

  it('persists multi-sentence project and goal replacements into managed memory for universal priority-goal phrasing', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.90')
      .send({
        content:
          'Я работаю над проектом Argus Memory Lab. Моя текущая цель — довести memory subsystem до production-ready состояния.',
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.91')
      .send({ content: 'Я уже не работаю над Argus Memory Lab. Теперь мой основной проект — Helios Control Plane.' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.92')
      .send({
        content:
          'Моя текущая цель уже не довести memory subsystem до production-ready состояния. Сейчас моя приоритетная цель — внедрить universal response directives и compliance retry.',
      })
      .expect(200);

    const snapshot = await adminGet('/api/chat/memory', TEST_USER_SCOPE_KEY)
      .set('x-forwarded-for', '10.0.0.93')
      .expect(200);

    expect(snapshot.body.userFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'project', value: 'Helios Control Plane' }),
        expect.objectContaining({ key: 'goal', value: 'внедрить universal response directives и compliance retry' }),
      ]),
    );
    expect(snapshot.body.userFacts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'project', value: 'Argus Memory Lab' }),
        expect.objectContaining({ key: 'goal', value: 'уже не довести memory subsystem до production-ready состояния' }),
      ]),
    );
  });

  it('forgets the replaced current project and keeps a trailing и потом покажи snapshot памяти inspect clause', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.94')
      .send({ content: 'Я работаю над проектом Argus Memory Lab.' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.95')
      .send({ content: 'Я уже не работаю над Argus Memory Lab. Теперь мой основной проект — Helios Control Plane.' })
      .expect(200);

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
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.53')
      .send({ content: 'My goal is preserve phase 8 chat pinning.' })
      .expect(200);

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
      .send({ content: 'Continue' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('goal=preserve phase 8 chat pinning [pinned]');
  });

  it('pins the goal through a conversational chat command even without explicit current wording', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.244')
      .send({ content: 'Моя текущая цель — стабилизировать natural-language goal pin routing.' })
      .expect(200);

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
      .send({ content: 'Продолжай' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.content).toContain(
      'goal=стабилизировать natural-language goal pin routing [pinned]',
    );
  });

  it('pins the replacement current goal after a negated goal update and shows it in the snapshot', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.97')
      .send({ content: 'Моя текущая цель — довести memory subsystem до production-ready состояния.' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.98')
      .send({
        content:
          'Моя текущая цель уже не довести memory subsystem до production-ready состояния. Сейчас приоритетная цель — внедрить universal response directives и compliance retry.',
      })
      .expect(200);

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
      'goal=внедрить universal response directives и compliance retry [pinned]',
    );
    expect(capturedCompleteMessages).toEqual([]);
  });

  it('handles multi-intent pin commands and keeps both the current goal and constraint visible later', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.66')
      .send({
        content:
          'Моя текущая цель — закрепить StressMultiPin memory. У нас есть ограничение: нельзя использовать vector database для StressMultiPin.',
      })
      .expect(200);

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
      .send({ content: 'Продолжай StressMultiPin' })
      .expect(200);

    expect(capturedCompleteMessages[0]?.role).toBe('system');
    expect(capturedCompleteMessages[0]?.content).toContain('goal=закрепить StressMultiPin memory');
    expect(capturedCompleteMessages[0]?.content).toContain('constraint=нельзя использовать vector database для StressMultiPin');
  });

  it('does not forget the current project when asked to forget an older project and then inspect memory', async () => {
    await request(app.getHttpServer())
      .post('/api/chat/messages')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.0.69')
      .send({ content: 'Я работаю над проектом StressHeliosOnly.' })
      .expect(200);

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
