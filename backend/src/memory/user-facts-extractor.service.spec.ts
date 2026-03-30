import { Conversation } from '../chat/entities/conversation.entity';
import { Message } from '../chat/entities/message.entity';
import { UserFactsExtractorService } from './user-facts-extractor.service';
import type { UserProfileFact, UserProfileFactRevision } from './user-profile-facts.types';

const createConversationWithUserMessages = (contents: string[]): Conversation => {
  const conversation = new Conversation({ id: 'conv-1' });
  contents.forEach((content, index) => {
    conversation.addMessage(
      new Message({
        id: `msg-${index}`,
        conversationId: conversation.id,
        role: 'user',
        content,
        createdAt: new Date(`2026-01-0${index + 1}T00:00:00.000Z`),
      }),
    );
  });
  return conversation;
};

const createFactProvenance = (messageId: string, createdAt: string, conversationId = 'conv-1') => ({
  firstObservedAt: createdAt,
  lastObservedAt: createdAt,
  firstObservedIn: {
    conversationId,
    messageId,
    createdAt,
  },
  lastObservedIn: {
    conversationId,
    messageId,
    createdAt,
  },
});

const createFactRevision = (
  revision: number,
  value: string,
  updatedAt: string,
  provenance?: ReturnType<typeof createFactProvenance>,
): UserProfileFactRevision => ({
  revision,
  value,
  confidence: 1,
  updatedAt,
  ...(provenance ? { provenance } : { provenance: { firstObservedAt: updatedAt, lastObservedAt: updatedAt } }),
});

const createExpectedFact = (
  key: UserProfileFact['key'],
  value: string,
  updatedAt: string,
  messageId?: string,
  options: {
    revision?: number;
    revisionHistory?: UserProfileFactRevision[];
    conversationId?: string;
  } = {},
): UserProfileFact => ({
  key,
  value,
  source: 'explicit_user_statement',
  confidence: 1,
  updatedAt,
  ...(messageId
    ? { provenance: createFactProvenance(messageId, updatedAt, options.conversationId) }
    : {}),
  ...(options.revision !== undefined ? { revision: options.revision } : {}),
  ...(options.revisionHistory ? { revisionHistory: options.revisionHistory } : {}),
});

describe('UserFactsExtractorService', () => {
  const service = new UserFactsExtractorService();

  it('extracts explicit durable user facts from english and russian phrasing', () => {
    const conversation = createConversationWithUserMessages([
      'My name is Alex. I am a backend engineer.',
      'Мой проект — Argus memory redesign.',
      'Моя цель — сделать агентную память надёжной.',
    ]);

    expect(service.resolveFacts(conversation)).toEqual<UserProfileFact[]>([
      createExpectedFact('name', 'Alex', '2026-01-01T00:00:00.000Z', 'msg-0', { revision: 1 }),
      createExpectedFact('role', 'backend engineer', '2026-01-01T00:00:00.000Z', 'msg-0', { revision: 1 }),
      createExpectedFact('project', 'Argus memory redesign', '2026-01-02T00:00:00.000Z', 'msg-1', { revision: 1 }),
      createExpectedFact('goal', 'сделать агентную память надёжной', '2026-01-03T00:00:00.000Z', 'msg-2', { revision: 1 }),
    ]);
  });

  it('extracts contrastive working-project phrasing from the same sentence as an indirect role statement', () => {
    const conversation = createConversationWithUserMessages([
      'По роли я скорее platform engineer, а мой основной рабочий проект — Orbit Notes.',
    ]);

    expect(service.resolveFacts(conversation)).toEqual<UserProfileFact[]>([
      createExpectedFact('role', 'platform engineer', '2026-01-01T00:00:00.000Z', 'msg-0', { revision: 1 }),
      createExpectedFact('project', 'Orbit Notes', '2026-01-01T00:00:00.000Z', 'msg-0', { revision: 1 }),
    ]);
  });

  it('replaces the current project after a multi-sentence negative update instead of keeping the stale persisted project', () => {
    const conversation = createConversationWithUserMessages([
      'Я уже не работаю над Argus Memory Lab.',
      'Теперь мой основной проект — Helios Control Plane.',
    ]);

    expect(
      service.resolveFacts(conversation, [
        {
          key: 'project',
          value: 'Argus Memory Lab',
          source: 'explicit_user_statement',
          confidence: 1,
          updatedAt: '2025-12-31T00:00:00.000Z',
        },
      ]),
    ).toEqual<UserProfileFact[]>([
      createExpectedFact('project', 'Helios Control Plane', '2026-01-02T00:00:00.000Z', 'msg-1', {
        revision: 2,
        revisionHistory: [createFactRevision(1, 'Argus Memory Lab', '2025-12-31T00:00:00.000Z')],
      }),
    ]);
  });

  it('lets the most recent explicit fact win over persisted facts with the same key', () => {
    const conversation = createConversationWithUserMessages(['I am working on Argus v2.']);

    expect(
      service.resolveFacts(conversation, [
        {
          key: 'project',
          value: 'Legacy project',
          source: 'explicit_user_statement',
          confidence: 1,
          updatedAt: '2025-12-31T00:00:00.000Z',
        },
      ]),
    ).toEqual<UserProfileFact[]>([
      createExpectedFact('project', 'Argus v2', '2026-01-01T00:00:00.000Z', 'msg-0', {
        revision: 2,
        revisionHistory: [createFactRevision(1, 'Legacy project', '2025-12-31T00:00:00.000Z')],
      }),
    ]);
  });

  it('invalidates outdated persisted facts when the user explicitly says they no longer apply', () => {
    const conversation = createConversationWithUserMessages(['I am no longer working on Argus.']);

    expect(
      service.resolveFacts(conversation, [
        {
          key: 'project',
          value: 'Argus',
          source: 'explicit_user_statement',
          confidence: 1,
          updatedAt: '2025-12-31T00:00:00.000Z',
        },
      ]),
    ).toEqual<UserProfileFact[]>([]);
  });

  it('extracts natural russian phrasing for role project and current goal without preserving sentence glue', () => {
    const conversation = createConversationWithUserMessages([
      'Моя роль — backend-разработчик.',
      'Я работаю над проектом Argus.',
      'Моя текущая цель — реализовать память между чатами.',
    ]);

    expect(service.resolveFacts(conversation)).toEqual<UserProfileFact[]>([
      createExpectedFact('role', 'backend-разработчик', '2026-01-01T00:00:00.000Z', 'msg-0', { revision: 1 }),
      createExpectedFact('project', 'Argus', '2026-01-02T00:00:00.000Z', 'msg-1', { revision: 1 }),
      createExpectedFact('goal', 'реализовать память между чатами', '2026-01-03T00:00:00.000Z', 'msg-2', { revision: 1 }),
    ]);
  });

  it('does not mistake direct questions about the user for new stored facts', () => {
    const conversation = createConversationWithUserMessages([
      'Напомни, пожалуйста, кто я в рабочем контексте, как меня зовут и над чем я вообще сейчас работаю.',
    ]);

    expect(service.resolveFacts(conversation)).toEqual<UserProfileFact[]>([]);
  });

  it('extracts explicit project and focus updates without dragging trailing contrast clauses into the value', () => {
    const conversation = createConversationWithUserMessages([
      'Теперь мой текущий проект Helios, но роль у меня прежняя.',
      'Теперь мой главный фокус аудит retrieval и устранение ложных ответов.',
    ]);

    expect(service.resolveFacts(conversation)).toEqual<UserProfileFact[]>([
      createExpectedFact('project', 'Helios', '2026-01-01T00:00:00.000Z', 'msg-0', { revision: 1 }),
      createExpectedFact('goal', 'аудит retrieval и устранение ложных ответов', '2026-01-02T00:00:00.000Z', 'msg-1', { revision: 1 }),
    ]);
  });

  it('extracts indirect role and current project phrasing and applies later contrastive project replacement', () => {
    const conversation = createConversationWithUserMessages([
      'Меня зовут Илья. По роли я скорее platform engineer. Сейчас основной рабочий проект у меня Nebula Desk.',
      'Проект у меня уже не Nebula Desk, а Orbit Notes.',
    ]);

    expect(service.resolveFacts(conversation)).toEqual<UserProfileFact[]>([
      createExpectedFact('name', 'Илья', '2026-01-01T00:00:00.000Z', 'msg-0', { revision: 1 }),
      createExpectedFact('role', 'platform engineer', '2026-01-01T00:00:00.000Z', 'msg-0', { revision: 1 }),
      createExpectedFact('project', 'Orbit Notes', '2026-01-02T00:00:00.000Z', 'msg-1', {
        revision: 2,
        revisionHistory: [
          createFactRevision(
            1,
            'Nebula Desk',
            '2026-01-01T00:00:00.000Z',
            createFactProvenance('msg-0', '2026-01-01T00:00:00.000Z'),
          ),
        ],
      }),
    ]);
  });

  it('strips trailing structured clauses from contrastive project updates separated by semicolons', () => {
    const conversation = createConversationWithUserMessages([
      'Проект у меня уже не Nebula Desk, а Orbit Notes; роль при этом не менялась.',
    ]);

    expect(service.resolveFacts(conversation)).toEqual<UserProfileFact[]>([
      createExpectedFact('project', 'Orbit Notes', '2026-01-01T00:00:00.000Z', 'msg-0', { revision: 1 }),
    ]);
  });

  it('extracts near-term goals and keeps only the replacement side of contrastive goal updates', () => {
    const conversation = createConversationWithUserMessages([
      'Моя ближайшая цель — довести cross-chat memory до стабильного состояния.',
      'Моя цель теперь не устранить ложные memory-ответы вообще, а конкретно стабилизировать command parsing и защиту от question-as-fact pollution.',
    ]);

    expect(service.resolveFacts(conversation)).toEqual<UserProfileFact[]>([
      createExpectedFact(
        'goal',
        'стабилизировать command parsing и защиту от question-as-fact pollution',
        '2026-01-02T00:00:00.000Z',
        'msg-1',
        { revision: 2, revisionHistory: [createFactRevision(1, 'довести cross-chat memory до стабильного состояния', '2026-01-01T00:00:00.000Z', createFactProvenance('msg-0', '2026-01-01T00:00:00.000Z'))] },
      ),
    ]);
  });

  it('stores the new priority goal after a negated current-goal update instead of persisting the negative fragment', () => {
    const conversation = createConversationWithUserMessages([
      'Моя текущая цель уже не довести memory subsystem до production-ready состояния.',
      'Сейчас приоритетная цель — внедрить universal response directives и compliance retry.',
    ]);

    expect(
      service.resolveFacts(conversation, [
        {
          key: 'goal',
          value: 'довести memory subsystem до production-ready состояния',
          source: 'explicit_user_statement',
          confidence: 1,
          updatedAt: '2025-12-31T00:00:00.000Z',
        },
      ]),
    ).toEqual<UserProfileFact[]>([
      createExpectedFact('goal', 'внедрить universal response directives и compliance retry', '2026-01-02T00:00:00.000Z', 'msg-1', {
        revision: 2,
        revisionHistory: [createFactRevision(1, 'довести memory subsystem до production-ready состояния', '2025-12-31T00:00:00.000Z')],
      }),
    ]);
  });

  it('stores the new priority goal when the user says сейчас моя приоритетная цель', () => {
    const conversation = createConversationWithUserMessages([
      'Моя текущая цель уже не довести memory subsystem до production-ready состояния.',
      'Сейчас моя приоритетная цель — внедрить universal response directives и compliance retry.',
    ]);

    expect(
      service.resolveFacts(conversation, [
        {
          key: 'goal',
          value: 'довести memory subsystem до production-ready состояния',
          source: 'explicit_user_statement',
          confidence: 1,
          updatedAt: '2025-12-31T00:00:00.000Z',
        },
      ]),
    ).toEqual<UserProfileFact[]>([
      createExpectedFact('goal', 'внедрить universal response directives и compliance retry', '2026-01-02T00:00:00.000Z', 'msg-1', {
        revision: 2,
        revisionHistory: [createFactRevision(1, 'довести memory subsystem до production-ready состояния', '2025-12-31T00:00:00.000Z')],
      }),
    ]);
  });

  it('does not treat deterministic memory commands as new durable facts when resolving a later snapshot', () => {
    const conversation = createConversationWithUserMessages([
      'Меня зовут Илья. Мой текущий проект — Orbit Notes. Моя текущая цель — стабилизировать memory extraction.',
      'Закрепи мою текущую цель и отдельно закрепи ограничение про vector database.',
    ]);

    expect(service.resolveFacts(conversation)).toEqual<UserProfileFact[]>([
      createExpectedFact('name', 'Илья', '2026-01-01T00:00:00.000Z', 'msg-0', { revision: 1 }),
      createExpectedFact('project', 'Orbit Notes', '2026-01-01T00:00:00.000Z', 'msg-0', { revision: 1 }),
      createExpectedFact('goal', 'стабилизировать memory extraction', '2026-01-01T00:00:00.000Z', 'msg-0', { revision: 1 }),
    ]);
  });

  it('keeps first-observation provenance but advances last observation when the same fact is restated later', () => {
    const conversation = createConversationWithUserMessages([
      'My current project is Orbit Notes.',
      'I am working on Orbit Notes.',
    ]);

    expect(service.resolveFacts(conversation)).toEqual<UserProfileFact[]>([
      {
        ...createExpectedFact('project', 'Orbit Notes', '2026-01-02T00:00:00.000Z', 'msg-1', { revision: 1 }),
        provenance: {
          firstObservedAt: '2026-01-01T00:00:00.000Z',
          lastObservedAt: '2026-01-02T00:00:00.000Z',
          firstObservedIn: {
            conversationId: 'conv-1',
            messageId: 'msg-0',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          lastObservedIn: {
            conversationId: 'conv-1',
            messageId: 'msg-1',
            createdAt: '2026-01-02T00:00:00.000Z',
          },
        },
      },
    ]);
  });

  it('does not store meta discussion about memory-command design as the current goal fact', () => {
    const conversation = createConversationWithUserMessages([
      'Я хочу обсудить дизайн команд памяти: фразы вида “можно было бы забыть старый проект” или “надо проверить pin/unpin” — это обсуждение, а не команда.',
    ]);

    expect(service.resolveFacts(conversation)).toEqual<UserProfileFact[]>([]);
  });
});
