import { TelegramMessageSender } from './telegram.message-sender';

function createMockBot(overrides: Record<string, jest.Mock> = {}): any {
  return {
    telegram: {
      sendChatAction: jest.fn().mockResolvedValue(true),
      sendMessage: jest.fn().mockResolvedValue({ message_id: 42 }),
      editMessageText: jest.fn().mockResolvedValue(true),
      ...overrides,
    },
  };
}

function createMockOutboundService(): any {
  return {
    executeSend: jest.fn(async (_metadata: unknown, perform: () => Promise<unknown>) => perform()),
  };
}

describe('TelegramMessageSender', () => {
  let sender: TelegramMessageSender;
  let outboundService: any;

  beforeEach(() => {
    outboundService = createMockOutboundService();
    sender = new TelegramMessageSender(outboundService);
  });

  describe('sendTypingAction', () => {
    it('sends typing action to the chat', async () => {
      const bot = createMockBot();
      await sender.sendTypingAction(bot, 123);
      expect(bot.telegram.sendChatAction).toHaveBeenCalledWith(123, 'typing');
    });

    it('does not throw on failure', async () => {
      const bot = createMockBot({
        sendChatAction: jest.fn().mockRejectedValue(new Error('network')),
      });
      await expect(sender.sendTypingAction(bot, 123)).resolves.toBeUndefined();
    });
  });

  describe('sendText', () => {
    it('sends markdown converted to HTML', async () => {
      const bot = createMockBot();
      const msgId = await sender.sendText(bot, 123, 'Hello');
      expect(bot.telegram.sendMessage).toHaveBeenCalledWith(123, 'Hello', expect.objectContaining({ parse_mode: 'HTML' }));
      expect(msgId).toBe(42);
    });

    it('converts **bold** to <b> tags', async () => {
      const bot = createMockBot();
      await sender.sendText(bot, 123, 'Hello **world**');
      const calledHtml = bot.telegram.sendMessage.mock.calls[0][1] as string;
      expect(calledHtml).toContain('<b>world</b>');
    });

    it('falls back to plain text if HTML fails', async () => {
      let callCount = 0;
      const sendMessage = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error('Bad html');
        return Promise.resolve({ message_id: 99 });
      });
      const bot = createMockBot({ sendMessage });

      const msgId = await sender.sendText(bot, 123, 'Hello');
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(msgId).toBe(99);
    });

    it('splits long messages into chunks', async () => {
      const bot = createMockBot();
      const longText = 'a'.repeat(5000);
      await sender.sendText(bot, 123, longText);
      expect(bot.telegram.sendMessage.mock.calls.length).toBeGreaterThan(1);
    });
  });

  describe('sendHtml', () => {
    it('sends pre-formatted HTML directly', async () => {
      const bot = createMockBot();
      const msgId = await sender.sendHtml(bot, 123, '<b>Hello</b>');
      expect(bot.telegram.sendMessage).toHaveBeenCalledWith(123, '<b>Hello</b>', expect.objectContaining({ parse_mode: 'HTML' }));
      expect(msgId).toBe(42);
    });
  });

  describe('sendPlaceholder', () => {
    it('sends placeholder and returns message ID', async () => {
      const bot = createMockBot();
      const msgId = await sender.sendPlaceholder(bot, 123);
      expect(bot.telegram.sendMessage).toHaveBeenCalledWith(123, '⏳', undefined);
      expect(msgId).toBe(42);
    });

    it('returns undefined on failure', async () => {
      const bot = createMockBot({
        sendMessage: jest.fn().mockRejectedValue(new Error('fail')),
      });
      const msgId = await sender.sendPlaceholder(bot, 123);
      expect(msgId).toBeUndefined();
    });
  });

  describe('editMessage', () => {
    it('edits message with HTML', async () => {
      const bot = createMockBot();
      const result = await sender.editMessage(bot, 123, 42, 'Updated text');
      expect(bot.telegram.editMessageText).toHaveBeenCalledWith(123, 42, undefined, 'Updated text', { parse_mode: 'HTML' });
      expect(result).toBe(true);
    });

    it('falls back to plain text on HTML failure', async () => {
      let callCount = 0;
      const editMessageText = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error('Bad html');
        return Promise.resolve(true);
      });
      const bot = createMockBot({ editMessageText });

      const result = await sender.editMessage(bot, 123, 42, 'test');
      expect(editMessageText).toHaveBeenCalledTimes(2);
      expect(result).toBe(true);
    });

    it('returns true for "message is not modified" error', async () => {
      const editMessageText = jest.fn()
        .mockRejectedValueOnce(new Error('Bad html'))
        .mockRejectedValueOnce(new Error('message is not modified'));
      const bot = createMockBot({ editMessageText });

      const result = await sender.editMessage(bot, 123, 42, 'same');
      expect(result).toBe(true);
    });

    it('truncates long messages before editing', async () => {
      const bot = createMockBot();
      const longText = 'x'.repeat(5000);
      await sender.editMessage(bot, 123, 42, longText);
      const calledWith = bot.telegram.editMessageText.mock.calls[0][3] as string;
      expect(calledWith.length).toBeLessThanOrEqual(4096);
      expect(calledWith.endsWith('...')).toBe(true);
    });
  });

  describe('sendError', () => {
    it('sends error message with warning emoji', async () => {
      const bot = createMockBot();
      await sender.sendError(bot, 123, 'Something broke');
      expect(bot.telegram.sendMessage).toHaveBeenCalledWith(123, '⚠️ Something broke', undefined);
    });
  });

  describe('escapeHtml', () => {
    it('escapes HTML special characters', () => {
      expect(sender.escapeHtml('<b>test</b>')).toBe('&lt;b&gt;test&lt;/b&gt;');
      expect(sender.escapeHtml('a & b')).toBe('a &amp; b');
    });

    it('leaves plain text unchanged', () => {
      expect(sender.escapeHtml('hello world')).toBe('hello world');
    });
  });

  describe('markdownToHtml', () => {
    it('converts bold', () => {
      expect(sender.markdownToHtml('**hello**')).toBe('<b>hello</b>');
    });

    it('converts italic', () => {
      expect(sender.markdownToHtml('*hello*')).toBe('<i>hello</i>');
    });

    it('converts inline code', () => {
      expect(sender.markdownToHtml('use `npm install`')).toBe('use <code>npm install</code>');
    });

    it('converts code blocks', () => {
      const md = '```js\nconsole.log("hi")\n```';
      const html = sender.markdownToHtml(md);
      expect(html).toContain('<pre>');
      expect(html).toContain('console.log');
    });

    it('escapes HTML entities in regular text', () => {
      expect(sender.markdownToHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
    });

    it('does not escape inside code blocks', () => {
      const md = '```\n<div>test</div>\n```';
      const html = sender.markdownToHtml(md);
      expect(html).toContain('&lt;div&gt;');
    });

    it('converts headings to bold', () => {
      expect(sender.markdownToHtml('## Title')).toBe('<b>Title</b>');
    });

    it('converts links', () => {
      expect(sender.markdownToHtml('[click](https://example.com)')).toBe('<a href="https://example.com">click</a>');
    });
  });
});
