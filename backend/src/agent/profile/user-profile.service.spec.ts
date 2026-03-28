import { Conversation } from '../../chat/entities/conversation.entity';
import { Message } from '../../chat/entities/message.entity';
import { UserProfileService } from './user-profile.service';

const createConversationWithUserMessages = (contents: string[]) => {
  const conversation = new Conversation({ id: 'conv-1' });
  for (const content of contents) {
    conversation.addMessage(
      new Message({
        conversationId: conversation.id,
        role: 'user',
        content,
      }),
    );
  }

  return conversation;
};

const createConversationWithUserMessage = (content: string) => {
  return createConversationWithUserMessages([content]);
};

describe('UserProfileService', () => {
  const service = new UserProfileService();

  it('returns the default profile when there is no user message', () => {
    const conversation = new Conversation({ id: 'conv-1' });

    expect(service.resolveProfile(conversation)).toEqual({
      communication: {
        preferredLanguage: 'auto',
        tone: 'direct',
        detail: 'adaptive',
        structure: 'adaptive',
      },
      interaction: {
        allowPushback: true,
        allowProactiveSuggestions: true,
      },
    });
  });

  it('infers russian detailed structured preferences from the latest message', () => {
    const conversation = createConversationWithUserMessage('Подробно и по пунктам объясни, не предлагай лишнего');

    expect(service.resolveProfile(conversation)).toEqual({
      communication: {
        preferredLanguage: 'ru',
        tone: 'direct',
        detail: 'detailed',
        structure: 'structured',
      },
      interaction: {
        allowPushback: true,
        allowProactiveSuggestions: false,
      },
    });
  });

  it('infers english concise preference and reduced pushback from the latest message', () => {
    const conversation = createConversationWithUserMessage('Briefly explain this and do not push back');

    expect(service.resolveProfile(conversation)).toEqual({
      communication: {
        preferredLanguage: 'en',
        tone: 'direct',
        detail: 'concise',
        structure: 'adaptive',
      },
      interaction: {
        allowPushback: false,
        allowProactiveSuggestions: true,
      },
    });
  });

  it('infers russian concise preference from simple phrasing', () => {
    const conversation = createConversationWithUserMessage('Ответь просто и без лишнего');

    expect(service.resolveProfile(conversation)).toEqual({
      communication: {
        preferredLanguage: 'ru',
        tone: 'direct',
        detail: 'concise',
        structure: 'adaptive',
      },
      interaction: {
        allowPushback: true,
        allowProactiveSuggestions: true,
      },
    });
  });

  it('infers russian concise preference from no-fluff phrasing', () => {
    const conversation = createConversationWithUserMessage('Кратко, без лишней воды');

    expect(service.resolveProfile(conversation)).toEqual({
      communication: {
        preferredLanguage: 'ru',
        tone: 'direct',
        detail: 'concise',
        structure: 'adaptive',
      },
      interaction: {
        allowPushback: true,
        allowProactiveSuggestions: true,
      },
    });
  });

  it('uses recent user context instead of only the latest message', () => {
    const conversation = createConversationWithUserMessages([
      'Пожалуйста, отвечай на русском и по-дружески',
      'А теперь просто объясни сам flow',
    ]);

    expect(service.resolveProfile(conversation)).toEqual({
      communication: {
        preferredLanguage: 'ru',
        tone: 'warm',
        detail: 'concise',
        structure: 'adaptive',
      },
      interaction: {
        allowPushback: true,
        allowProactiveSuggestions: true,
      },
    });
  });

  it('does not treat standalone topic wording with "просто" as a concise preference', () => {
    const conversation = createConversationWithUserMessage('Это просто пример бага в кеше');

    expect(service.resolveProfile(conversation).communication.detail).toBe('adaptive');
  });

  it('lets the most recent explicit interaction preference win', () => {
    const conversation = createConversationWithUserMessages([
      'Не предлагай следующие шаги',
      'Нет, можешь предлагать следующие шаги',
    ]);

    expect(service.resolveProfile(conversation).interaction.allowProactiveSuggestions).toBe(true);
  });

  it('detects explicit "подробнее" wording and enabling suggestions from natural russian phrasing', () => {
    const conversation = createConversationWithUserMessage(
      'Теперь поменяй стиль: отвечай подробнее, теплее и с примерами. В конце можно предлагать следующие шаги.',
    );

    expect(
      service.resolveProfile(conversation, {
        communication: {
          preferredLanguage: 'ru',
          tone: 'direct',
          detail: 'concise',
          structure: 'structured',
        },
        interaction: {
          allowPushback: true,
          allowProactiveSuggestions: false,
        },
      }),
    ).toEqual({
      communication: {
        preferredLanguage: 'ru',
        tone: 'warm',
        detail: 'detailed',
        structure: 'structured',
      },
      interaction: {
        allowPushback: true,
        allowProactiveSuggestions: true,
      },
    });
  });

  it('detects the ё-variant of "развёрнуто" as a detailed preference', () => {
    const conversation = createConversationWithUserMessage('Ответь развёрнуто и по делу');

    expect(service.resolveProfile(conversation).communication.detail).toBe('detailed');
  });

  it('detects formal tone preference from the latest explicit request', () => {
    const conversation = createConversationWithUserMessages([
      'Отвечай по-дружески',
      'Лучше формально и по делу',
    ]);

    expect(service.resolveProfile(conversation).communication.tone).toBe('formal');
  });

  it('persists default response-format preferences from explicit default-answer phrasing', () => {
    const conversation = createConversationWithUserMessage(
      'Запомни как дефолт ответа: сначала 2 коротких пункта что делаем/что сломано, потом детали и риски, без длинного эссе.',
    );

    expect(service.resolveProfileForPersistence(conversation)).toEqual({
      communication: {
        preferredLanguage: 'auto',
        tone: 'direct',
        detail: 'concise',
        structure: 'structured',
      },
      interaction: {
        allowPushback: true,
        allowProactiveSuggestions: true,
      },
    });
  });

  it('persists explicit russian default-response preferences from imperative phrasing', () => {
    const conversation = createConversationWithUserMessage(
      'Отвечай по-русски, коротко и по пунктам; это мой дефолтный формат, в конце можешь предлагать следующие шаги.',
    );

    expect(service.resolveProfileForPersistence(conversation)).toEqual({
      communication: {
        preferredLanguage: 'ru',
        tone: 'direct',
        detail: 'concise',
        structure: 'structured',
      },
      interaction: {
        allowPushback: true,
        allowProactiveSuggestions: true,
      },
    });
  });

  it('persists explicit now-change-style phrasing as durable response preferences', () => {
    const conversation = createConversationWithUserMessage(
      'Теперь поменяй стиль: отвечай подробнее, теплее и с примерами. В конце можно предлагать следующие шаги.',
    );

    expect(service.resolveProfileForPersistence(conversation)).toEqual({
      communication: {
        preferredLanguage: 'auto',
        tone: 'warm',
        detail: 'detailed',
        structure: 'adaptive',
      },
      interaction: {
        allowPushback: true,
        allowProactiveSuggestions: true,
      },
    });
  });

  it('falls back to auto language for mixed-language recent context without a clear winner', () => {
    const conversation = createConversationWithUserMessages([
      'Brief answer please',
      'Ответь коротко',
    ]);

    expect(service.resolveProfile(conversation).communication.preferredLanguage).toBe('auto');
  });

  it('merges inferred preferences onto a persisted base profile', () => {
    const conversation = createConversationWithUserMessage('Кратко, по пунктам');

    expect(
      service.resolveProfile(conversation, {
        communication: {
          preferredLanguage: 'ru',
          tone: 'warm',
          detail: 'adaptive',
          structure: 'adaptive',
        },
        interaction: {
          allowPushback: false,
          allowProactiveSuggestions: false,
        },
      }),
    ).toEqual({
      communication: {
        preferredLanguage: 'ru',
        tone: 'warm',
        detail: 'concise',
        structure: 'structured',
      },
      interaction: {
        allowPushback: false,
        allowProactiveSuggestions: false,
      },
    });
  });
});
