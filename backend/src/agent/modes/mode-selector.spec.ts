import { Conversation } from '../../chat/entities/conversation.entity';
import { Message } from '../../chat/entities/message.entity';
import { ModeSelector } from './mode-selector';
import { RegexModeClassifier } from './regex-mode-classifier';

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

describe('ModeSelector', () => {
  const selector = new ModeSelector(new RegexModeClassifier());

  it('falls back to assistant mode when there is no user message', () => {
    const conversation = new Conversation({ id: 'conv-1' });

    expect(selector.selectMode(conversation)).toBe('assistant');
  });

  it('selects operator mode for execution-oriented requests', () => {
    const conversation = createConversationWithUserMessage('Исправь баг и сделай пошагово план фикса');

    expect(selector.selectMode(conversation)).toBe('operator');
  });

  it('selects strategist mode for planning and architecture requests', () => {
    const conversation = createConversationWithUserMessage('Какой план и архитектурная стратегия лучше для этого продукта?');

    expect(selector.selectMode(conversation)).toBe('strategist');
  });

  it('selects researcher mode for investigation requests', () => {
    const conversation = createConversationWithUserMessage('Изучи варианты и сравни их плюсы и минусы');

    expect(selector.selectMode(conversation)).toBe('researcher');
  });

  it('selects reflective mode for introspective requests', () => {
    const conversation = createConversationWithUserMessage('Я застрял, сомневаюсь и не понимаю что делать дальше');

    expect(selector.selectMode(conversation)).toBe('reflective');
  });

  it('keeps the previous confident mode for short continuation messages', () => {
    const conversation = createConversationWithUserMessages([
      'Нужна архитектурная стратегия и roadmap для этого продукта',
      'давай дальше',
    ]);

    expect(selector.selectMode(conversation)).toBe('strategist');
  });

  it('falls back to assistant mode for weak single-signal prompts', () => {
    const conversation = createConversationWithUserMessage('Нужен план');

    expect(selector.selectMode(conversation)).toBe('assistant');
  });
});
