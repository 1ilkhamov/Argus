/**
 * Characterization tests for UserProfileService.
 *
 * Purpose: freeze the current behavior of every pattern family, the
 * recent-user-message window, language voting, boolean preference
 * precedence, and base-profile merging BEFORE any refactoring begins.
 *
 * These tests document what the code does today — not what it ideally should do.
 */
import { Conversation } from '../../chat/entities/conversation.entity';
import { Message } from '../../chat/entities/message.entity';
import { UserProfileService } from './user-profile.service';
import { DEFAULT_AGENT_USER_PROFILE, type AgentUserProfile } from './user-profile.types';

const service = new UserProfileService();

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const conv = (...userContents: string[]): Conversation => {
  const conversation = new Conversation({ id: 'conv-char' });
  userContents.forEach((content) => {
    conversation.addMessage(
      new Message({ conversationId: conversation.id, role: 'user', content }),
    );
  });
  return conversation;
};

const convWithAssistant = (messages: Array<{ role: 'user' | 'assistant'; content: string }>): Conversation => {
  const conversation = new Conversation({ id: 'conv-char-mixed' });
  messages.forEach((msg) => {
    conversation.addMessage(
      new Message({ conversationId: conversation.id, role: msg.role, content: msg.content }),
    );
  });
  return conversation;
};

const resolve = (...userContents: string[]) => service.resolveProfile(conv(...userContents));
const patch = (...userContents: string[]) => service.inferProfilePatch(conv(...userContents));

/* ------------------------------------------------------------------ */
/*  1. Baseline – empty conversations                                  */
/* ------------------------------------------------------------------ */

describe('UserProfileService – characterization', () => {
  describe('baseline', () => {
    it('returns default profile for an empty conversation', () => {
      expect(resolve()).toEqual(DEFAULT_AGENT_USER_PROFILE);
    });

    it('returns empty patch for an empty conversation', () => {
      expect(patch()).toEqual({});
    });

    it('returns default profile when only assistant messages exist', () => {
      const conversation = convWithAssistant([
        { role: 'assistant', content: 'Hello, how can I help?' },
      ]);
      expect(service.resolveProfile(conversation)).toEqual(DEFAULT_AGENT_USER_PROFILE);
    });

    it('returns default profile when user messages are empty strings', () => {
      expect(resolve('', '  ', '\n')).toEqual(DEFAULT_AGENT_USER_PROFILE);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  2. Language detection – explicit patterns                          */
  /* ------------------------------------------------------------------ */

  describe('language – explicit patterns', () => {
    it.each([
      'in russian please',
      'answer in russian',
      'respond in russian',
      'russian please',
      'на русском ответь',
      'по-русски',
      'ответь на русском',
      'отвечай по-русски',
    ])('detects explicit russian for: "%s"', (input) => {
      expect(resolve(input).communication.preferredLanguage).toBe('ru');
    });

    it.each([
      'in english please',
      'answer in english',
      'respond in english',
      'english please',
      'на английском',
      'по-английски',
      'ответь на английском',
      'отвечай по-английски',
    ])('detects explicit english for: "%s"', (input) => {
      expect(resolve(input).communication.preferredLanguage).toBe('en');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  3. Language detection – character voting                            */
  /* ------------------------------------------------------------------ */

  describe('language – character voting', () => {
    it('infers russian from predominantly cyrillic content', () => {
      expect(resolve('Объясни мне архитектуру').communication.preferredLanguage).toBe('ru');
    });

    it('infers english from predominantly latin content', () => {
      expect(resolve('Explain the architecture').communication.preferredLanguage).toBe('en');
    });

    it('returns auto when cyrillic and latin are balanced across messages', () => {
      expect(resolve('Brief answer please', 'Ответь коротко').communication.preferredLanguage).toBe('auto');
    });

    it('explicit language request wins over character voting', () => {
      // First message is in Russian but asks for English
      expect(resolve('ответь на английском пожалуйста').communication.preferredLanguage).toBe('en');
    });

    it('most recent explicit language request wins (last message is newest)', () => {
      // conv() adds messages in order, so 'please answer in English' is the most recent
      expect(
        resolve('ответь на русском', 'please answer in English').communication.preferredLanguage,
      ).toBe('en');
    });

    it('earlier explicit language wins when it is the most recent message', () => {
      expect(
        resolve('please answer in English', 'ответь на русском').communication.preferredLanguage,
      ).toBe('ru');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  4. Tone detection                                                  */
  /* ------------------------------------------------------------------ */

  describe('tone detection', () => {
    it.each([
      ['to the point', 'direct'],
      ['straight to the point', 'direct'],
      ['по делу ответь', 'direct'],
      ['прямо и без лишнего', 'direct'],
    ] as const)('detects direct tone for: "%s"', (input, expected) => {
      expect(resolve(input).communication.tone).toBe(expected);
    });

    it.each([
      ['warm tone please', 'warm'],
      ['be friendly', 'warm'],
      ['gentle explanation', 'warm'],
      ['supportive', 'warm'],
      ['тепло ответь', 'warm'],
      ['дружелюбно', 'warm'],
      ['мягко объясни', 'warm'],
      ['бережно', 'warm'],
    ] as const)('detects warm tone for: "%s"', (input, expected) => {
      expect(resolve(input).communication.tone).toBe(expected);
    });

    it.each([
      ['formal style please', 'formal'],
      ['professionally explain', 'formal'],
      ['формально ответь', 'formal'],
      ['официально', 'formal'],
    ] as const)('detects formal tone for: "%s"', (input, expected) => {
      expect(resolve(input).communication.tone).toBe(expected);
    });

    it('defaults to direct tone when no explicit tone is detected', () => {
      expect(resolve('What is CQRS?').communication.tone).toBe('direct');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  5. Detail preference detection                                     */
  /* ------------------------------------------------------------------ */

  describe('detail preference', () => {
    it.each([
      'short answer',
      'brief explanation',
      'briefly explain',
      'concise please',
      'compact answer',
      'no fluff',
      'simple explain this',
      'explain simply',
      'кратко ответь',
      'коротко',
      'в двух словах',
      'в двух предложениях',
      'простыми словами',
      'без лишнего',
      'без лишней воды',
      'максимально коротко',
      'ответь просто',
      'объясни просто',
      'просто объясни',
      'просто скажи',
      'просто ответь',
      'компактно',
    ])('detects concise for: "%s"', (input) => {
      expect(resolve(input).communication.detail).toBe('concise');
    });

    it.each([
      'detailed answer please',
      'deep dive into this',
      'in depth explanation',
      'thorough analysis',
      'more detail please',
      'more detailed',
      'elaborate on this',
      'подробно',
      'подробнее',
      'детально',
      'детальнее',
      'глубоко',
      'развернуто',
      'развёрнуто',
    ])('detects detailed for: "%s"', (input) => {
      expect(resolve(input).communication.detail).toBe('detailed');
    });

    it('does not treat standalone "просто" as concise', () => {
      expect(resolve('Это просто пример бага в кеше').communication.detail).toBe('adaptive');
    });

    it('defaults to adaptive when no detail preference is detected', () => {
      expect(resolve('What is polymorphism?').communication.detail).toBe('adaptive');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  6. Structure preference detection                                  */
  /* ------------------------------------------------------------------ */

  describe('structure preference', () => {
    it.each([
      'step-by-step please',
      'bullet points',
      'bullet list',
      'numbered list',
      'structured answer',
      'outline the approach',
      'по пунктам',
      'структурно',
      'пошагово',
      'по шагам',
      'поэтапно',
      'списком',
      'нумерованным списком',
    ])('detects structured for: "%s"', (input) => {
      expect(resolve(input).communication.structure).toBe('structured');
    });

    it('defaults to adaptive when no structure preference is detected', () => {
      expect(resolve('Explain the pattern').communication.structure).toBe('adaptive');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  7. Boolean preferences – pushback                                  */
  /* ------------------------------------------------------------------ */

  describe('pushback preference', () => {
    it.each([
      "don't push back",
      'do not push back',
      'не спорь',
      'не возражай',
      'без критики',
    ])('disables pushback for: "%s"', (input) => {
      expect(resolve(input).interaction.allowPushback).toBe(false);
    });

    it.each([
      'push back if needed',
      'challenge me',
      'be critical if needed',
      'можешь спорить',
      'можешь возражать',
      'критикуй если нужно',
      'возражай если нужно',
    ])('enables pushback for: "%s"', (input) => {
      expect(resolve(input).interaction.allowPushback).toBe(true);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  8. Boolean preferences – suggestions                               */
  /* ------------------------------------------------------------------ */

  describe('suggestion preference', () => {
    it.each([
      'no suggestions',
      "don't suggest anything",
      'do not suggest',
      'без предложений',
      'не предлагай',
    ])('disables suggestions for: "%s"', (input) => {
      expect(resolve(input).interaction.allowProactiveSuggestions).toBe(false);
    });

    it.each([
      'give suggestions',
      'suggest next steps',
      'propose next steps',
      'you can suggest',
      'feel free to suggest',
      'можешь предлагать',
      'можно предлагать',
      'предлагай',
      'предложи следующие шаги',
      'в конце можешь предлагать',
    ])('enables suggestions for: "%s"', (input) => {
      expect(resolve(input).interaction.allowProactiveSuggestions).toBe(true);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  9. Recent-user-message window                                      */
  /* ------------------------------------------------------------------ */

  describe('recent-user-message window', () => {
    it('considers up to 6 recent user messages', () => {
      // 7 messages; the oldest (msg-0) sets 'formal', messages 1-6 have no tone signal
      // Since window is 6, msg-0 should be outside the window and not counted
      const messages = [
        'Use formal tone',
        'What is DDD?',
        'Explain event sourcing',
        'How does CQRS work?',
        'What about saga pattern?',
        'Tell me about outbox pattern',
        'And materialized views?',
      ];
      const profile = resolve(...messages);
      // 'formal' was in the 7th message (oldest), outside the 6-message window
      // Since messages are reversed and the latest 6 are taken, 'Use formal tone' is the 7th from the end
      expect(profile.communication.tone).toBe('direct');
    });

    it('picks up tone from within the 6-message window', () => {
      const messages = [
        'What is DDD?',
        'Explain event sourcing',
        'How does CQRS work?',
        'What about saga pattern?',
        'Tell me about outbox pattern',
        'And materialized views? Use formal tone',
      ];
      const profile = resolve(...messages);
      expect(profile.communication.tone).toBe('formal');
    });

    it('ignores assistant messages when building the window', () => {
      const conversation = convWithAssistant([
        { role: 'user', content: 'Use warm tone' },
        { role: 'assistant', content: 'Sure, I will use a warm tone.' },
        { role: 'user', content: 'What is DDD?' },
      ]);
      expect(service.resolveProfile(conversation).communication.tone).toBe('warm');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  10. Most-recent explicit preference wins                           */
  /* ------------------------------------------------------------------ */

  describe('most-recent-wins precedence', () => {
    it('most recent tone wins when multiple messages set tone', () => {
      expect(resolve('Use warm tone', 'Use formal tone').communication.tone).toBe('formal');
    });

    it('most recent detail wins when multiple messages set detail', () => {
      expect(resolve('be concise', 'be detailed please').communication.detail).toBe('detailed');
    });

    it('most recent boolean (pushback) wins', () => {
      expect(resolve("don't push back", 'push back if needed').interaction.allowPushback).toBe(true);
    });

    it('most recent boolean (suggestions) wins', () => {
      expect(resolve('no suggestions', 'give suggestions').interaction.allowProactiveSuggestions).toBe(true);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  11. Base profile merging                                           */
  /* ------------------------------------------------------------------ */

  describe('base profile merging', () => {
    it('inferred preferences override base profile fields', () => {
      const base: AgentUserProfile = {
        communication: {
          preferredLanguage: 'en',
          tone: 'formal',
          detail: 'detailed',
          structure: 'structured',
        },
        interaction: {
          allowPushback: false,
          allowProactiveSuggestions: false,
        },
      };
      const result = service.resolveProfile(conv('Кратко и мягко'), base);
      expect(result.communication.detail).toBe('concise');
      expect(result.communication.tone).toBe('warm');
      // Non-inferred fields preserve base
      expect(result.communication.structure).toBe('structured');
      expect(result.interaction.allowPushback).toBe(false);
      expect(result.interaction.allowProactiveSuggestions).toBe(false);
    });

    it('preserves all base fields when no signals are detected', () => {
      const base: AgentUserProfile = {
        communication: {
          preferredLanguage: 'en',
          tone: 'formal',
          detail: 'detailed',
          structure: 'structured',
        },
        interaction: {
          allowPushback: false,
          allowProactiveSuggestions: false,
        },
      };
      // Generic question with no signals
      const result = service.resolveProfile(conv('What time is it?'), base);
      expect(result.communication.tone).toBe('formal');
      expect(result.communication.detail).toBe('detailed');
      expect(result.communication.structure).toBe('structured');
      expect(result.interaction.allowPushback).toBe(false);
      expect(result.interaction.allowProactiveSuggestions).toBe(false);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  12. Combined multi-signal messages                                 */
  /* ------------------------------------------------------------------ */

  describe('combined multi-signal messages', () => {
    it('detects language + detail + structure + suggestion in one message', () => {
      const result = resolve('Подробно, по пунктам. Можешь предлагать следующие шаги.');
      expect(result.communication.preferredLanguage).toBe('ru');
      expect(result.communication.detail).toBe('detailed');
      expect(result.communication.structure).toBe('structured');
      expect(result.interaction.allowProactiveSuggestions).toBe(true);
    });

    it('detects english + concise + no pushback in one message', () => {
      const result = resolve('Briefly explain, do not push back');
      expect(result.communication.preferredLanguage).toBe('en');
      expect(result.communication.detail).toBe('concise');
      expect(result.interaction.allowPushback).toBe(false);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  13. inferProfilePatch structure                                    */
  /* ------------------------------------------------------------------ */

  describe('inferProfilePatch output structure', () => {
    it('only includes communication key when communication signals are found', () => {
      const p = patch('Объясни кратко');
      expect(p).toHaveProperty('communication');
      expect(p).not.toHaveProperty('interaction');
    });

    it('only includes interaction key when interaction signals are found', () => {
      const p = patch('do not push back');
      expect(p).toHaveProperty('interaction');
      // language is still detected from latin content
    });

    it('includes both when both types of signals are found', () => {
      const p = patch('Кратко, не предлагай лишнего');
      expect(p).toHaveProperty('communication');
      expect(p).toHaveProperty('interaction');
    });

    it('returns empty object when no signals are found', () => {
      expect(patch('42')).toEqual({});
    });
  });
});
