import { Conversation } from '../chat/entities/conversation.entity';
import { Message } from '../chat/entities/message.entity';
import { UserFactsLifecycleService } from './user-facts-lifecycle.service';
import type { UserProfileFact } from './user-profile-facts.types';

const expectFact = (partial: Partial<UserProfileFact>) => expect.objectContaining(partial);

const createConversationWithUserMessages = (contents: string[]): Conversation => {
  const conversation = new Conversation({ id: 'conv-user-facts-lifecycle' });
  contents.forEach((content, index) => {
    conversation.addMessage(
      new Message({
        id: `msg-${index}`,
        conversationId: conversation.id,
        role: 'user',
        content,
        createdAt: new Date(`2026-03-0${index + 1}T00:00:00.000Z`),
      }),
    );
  });
  return conversation;
};

describe('UserFactsLifecycleService', () => {
  const service = new UserFactsLifecycleService();

  it('merges duplicate facts by key and keeps the latest equivalent value', () => {
    const facts: UserProfileFact[] = [
      {
        key: 'project',
        value: 'Argus',
        source: 'explicit_user_statement',
        confidence: 0.9,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        key: 'project',
        value: '  argus  ',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
    ];

    expect(service.prepareFactsForStorage(facts)).toEqual([
      expectFact({
        key: 'project',
        value: 'argus',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-02-01T00:00:00.000Z',
      }),
    ]);
  });

  it('keeps durable facts but filters stale goals out of prompt-visible facts', () => {
    const facts: UserProfileFact[] = [
      {
        key: 'name',
        value: 'Alex',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
      {
        key: 'goal',
        value: 'ship phase 1 prototype',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    ];

    expect(service.selectPromptFacts(facts, undefined, new Date('2026-03-18T00:00:00.000Z'))).toEqual([
      expectFact({
        key: 'name',
        value: 'Alex',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2025-01-01T00:00:00.000Z',
      }),
    ]);
  });

  it('promotes relevant project facts over low-value unrelated facts for the current request', () => {
    const facts: UserProfileFact[] = [
      {
        key: 'name',
        value: 'Alex',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
      {
        key: 'project',
        value: 'Argus memory redesign',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-02T00:00:00.000Z',
      },
    ];
    const conversation = createConversationWithUserMessages(['Continue the Argus memory redesign plan']);

    expect(service.selectPromptFacts(facts, conversation, new Date('2026-03-18T00:00:00.000Z'))).toEqual([
      expectFact({
        key: 'project',
        value: 'Argus memory redesign',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-02T00:00:00.000Z',
      }),
    ]);
  });

  it('keeps a pinned fact prompt-visible even when the current request is not lexically related', () => {
    const facts: UserProfileFact[] = [
      {
        key: 'project',
        value: 'Argus',
        source: 'explicit_user_statement',
        confidence: 1,
        pinned: true,
        updatedAt: '2026-03-02T00:00:00.000Z',
      },
    ];
    const conversation = createConversationWithUserMessages(['Continue']);

    expect(service.selectPromptFacts(facts, conversation, new Date('2026-03-18T00:00:00.000Z'))).toEqual([
      expectFact({
        key: 'project',
        value: 'Argus',
        source: 'explicit_user_statement',
        confidence: 1,
        pinned: true,
        updatedAt: '2026-03-02T00:00:00.000Z',
      }),
    ]);
  });

  it('keeps directly requested identity facts prompt-visible even when the request uses different wording than the stored key', () => {
    const facts: UserProfileFact[] = [
      {
        key: 'name',
        value: 'Алекс',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
      {
        key: 'role',
        value: 'backend-разработчик',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-02T00:00:00.000Z',
      },
    ];
    const conversation = createConversationWithUserMessages(['Как меня зовут?']);

    expect(service.selectPromptFacts(facts, conversation, new Date('2026-03-18T00:00:00.000Z'))).toEqual([
      expectFact({
        key: 'name',
        value: 'Алекс',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
    ]);
  });

  it('keeps multiple directly requested fact keys prompt-visible for a compound russian identity question', () => {
    const facts: UserProfileFact[] = [
      {
        key: 'name',
        value: 'Марк',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
      {
        key: 'role',
        value: 'backend-разработчик',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-02T00:00:00.000Z',
      },
      {
        key: 'project',
        value: 'StressRecallAlpha',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-03T00:00:00.000Z',
      },
    ];
    const conversation = createConversationWithUserMessages([
      'Напомни, пожалуйста, кто я в рабочем контексте, как меня зовут и над чем я вообще сейчас работаю.',
    ]);

    expect(service.selectPromptFacts(facts, conversation, new Date('2026-03-18T00:00:00.000Z'))).toEqual([
      expectFact({
        key: 'project',
        value: 'StressRecallAlpha',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-03T00:00:00.000Z',
      }),
      expectFact({
        key: 'role',
        value: 'backend-разработчик',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-02T00:00:00.000Z',
      }),
      expectFact({
        key: 'name',
        value: 'Марк',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
    ]);
  });

  it('treats professional-context recall phrasing as a direct role and project request', () => {
    const facts: UserProfileFact[] = [
      {
        key: 'role',
        value: 'platform engineer',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-02T00:00:00.000Z',
      },
      {
        key: 'project',
        value: 'Orbit Notes',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-03T00:00:00.000Z',
      },
    ];
    const conversation = createConversationWithUserMessages([
      'Что ты помнишь обо мне как о специалисте и над чем я работаю?',
    ]);

    expect(service.selectPromptFacts(facts, conversation, new Date('2026-03-18T00:00:00.000Z'))).toEqual([
      expectFact({
        key: 'project',
        value: 'Orbit Notes',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-03T00:00:00.000Z',
      }),
      expectFact({
        key: 'role',
        value: 'platform engineer',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-02T00:00:00.000Z',
      }),
    ]);
  });

  it('treats current-project wording as a direct project request for prompt selection', () => {
    const facts: UserProfileFact[] = [
      {
        key: 'project',
        value: 'Orbit Notes',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-03T00:00:00.000Z',
      },
    ];
    const conversation = createConversationWithUserMessages(['Какой у меня текущий проект?']);

    expect(service.selectPromptFacts(facts, conversation, new Date('2026-03-18T00:00:00.000Z'))).toEqual([
      expectFact({
        key: 'project',
        value: 'Orbit Notes',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-03T00:00:00.000Z',
      }),
    ]);
  });

  it('normalizes legacy polluted role project and goal values before prompt selection', () => {
    const facts: UserProfileFact[] = [
      {
        key: 'role',
        value: 'роль — backend-разработчик',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
      {
        key: 'project',
        value: 'теперь Orbit Notes',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-02T00:00:00.000Z',
      },
      {
        key: 'goal',
        value: 'теперь не старая цель, а конкретно стабилизировать command parsing',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-03T00:00:00.000Z',
      },
    ];

    expect(service.prepareFactsForStorage(facts)).toEqual([
      expectFact({
        key: 'role',
        value: 'backend-разработчик',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
      expectFact({
        key: 'project',
        value: 'Orbit Notes',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-02T00:00:00.000Z',
      }),
      expectFact({
        key: 'goal',
        value: 'стабилизировать command parsing',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-03T00:00:00.000Z',
      }),
    ]);
  });

  it('preserves provenance and revision history when equivalent facts are merged', () => {
    const facts: UserProfileFact[] = [
      {
        key: 'project',
        value: 'Argus',
        source: 'explicit_user_statement',
        confidence: 0.9,
        updatedAt: '2026-03-01T00:00:00.000Z',
        revision: 2,
        provenance: {
          firstObservedAt: '2026-02-01T00:00:00.000Z',
          lastObservedAt: '2026-03-01T00:00:00.000Z',
          firstObservedIn: {
            conversationId: 'conv-user-facts-lifecycle',
            messageId: 'msg-origin',
            createdAt: '2026-02-01T00:00:00.000Z',
          },
          lastObservedIn: {
            conversationId: 'conv-user-facts-lifecycle',
            messageId: 'msg-0',
            createdAt: '2026-03-01T00:00:00.000Z',
          },
        },
        revisionHistory: [
          {
            revision: 1,
            value: 'Legacy Argus',
            confidence: 1,
            updatedAt: '2026-02-01T00:00:00.000Z',
            provenance: {
              firstObservedAt: '2026-02-01T00:00:00.000Z',
              lastObservedAt: '2026-02-01T00:00:00.000Z',
            },
          },
        ],
      },
      {
        key: 'project',
        value: ' argus ',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-02T00:00:00.000Z',
        revision: 2,
        provenance: {
          firstObservedAt: '2026-03-02T00:00:00.000Z',
          lastObservedAt: '2026-03-02T00:00:00.000Z',
          firstObservedIn: {
            conversationId: 'conv-user-facts-lifecycle',
            messageId: 'msg-1',
            createdAt: '2026-03-02T00:00:00.000Z',
          },
          lastObservedIn: {
            conversationId: 'conv-user-facts-lifecycle',
            messageId: 'msg-1',
            createdAt: '2026-03-02T00:00:00.000Z',
          },
        },
      },
    ];

    expect(service.prepareFactsForStorage(facts)).toEqual([
      expectFact({
        key: 'project',
        value: 'argus',
        revision: 2,
        provenance: {
          firstObservedAt: '2026-02-01T00:00:00.000Z',
          lastObservedAt: '2026-03-02T00:00:00.000Z',
          firstObservedIn: {
            conversationId: 'conv-user-facts-lifecycle',
            messageId: 'msg-origin',
            createdAt: '2026-02-01T00:00:00.000Z',
          },
          lastObservedIn: {
            conversationId: 'conv-user-facts-lifecycle',
            messageId: 'msg-1',
            createdAt: '2026-03-02T00:00:00.000Z',
          },
        },
        revisionHistory: [
          expect.objectContaining({
            revision: 1,
            value: 'Legacy Argus',
          }),
        ],
      }),
    ]);
  });
});
