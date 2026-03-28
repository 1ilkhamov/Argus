import { TelegramVoiceHandler } from './telegram.voice-handler';

// Mock fs and fetch
jest.mock('node:fs', () => ({
  promises: {
    writeFile: jest.fn().mockResolvedValue(undefined),
    unlink: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockTranscriptionService = {
  transcribe: jest.fn(),
};

function createMockBot(fileUrl = 'https://api.telegram.org/file/bot123/voice.ogg'): any {
  return {
    telegram: {
      getFileLink: jest.fn().mockResolvedValue(new URL(fileUrl)),
    },
  };
}

describe('TelegramVoiceHandler', () => {
  let handler: TelegramVoiceHandler;

  beforeEach(() => {
    jest.clearAllMocks();
    handler = new TelegramVoiceHandler(mockTranscriptionService as any);

    // Mock global fetch
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    });
  });

  afterEach(() => {
    delete (global as any).fetch;
  });

  it('downloads file, transcribes, and returns text', async () => {
    mockTranscriptionService.transcribe.mockResolvedValue({ text: 'Hello world' });
    const bot = createMockBot();

    const result = await handler.transcribe(bot, 'file-123');

    expect(bot.telegram.getFileLink).toHaveBeenCalledWith('file-123');
    expect(mockTranscriptionService.transcribe).toHaveBeenCalledWith(
      expect.stringContaining('argus-tg-voice-'),
      undefined,
    );
    expect(result).toBe('Hello world');
  });

  it('passes language parameter to transcription service', async () => {
    mockTranscriptionService.transcribe.mockResolvedValue({ text: 'Привет мир' });
    const bot = createMockBot();

    await handler.transcribe(bot, 'file-123', 'ru');

    expect(mockTranscriptionService.transcribe).toHaveBeenCalledWith(
      expect.any(String),
      'ru',
    );
  });

  it('returns null when transcription result is empty', async () => {
    mockTranscriptionService.transcribe.mockResolvedValue({ text: '   ' });
    const bot = createMockBot();

    const result = await handler.transcribe(bot, 'file-123');
    expect(result).toBeNull();
  });

  it('returns null when file download fails', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      statusText: 'Not Found',
    });
    const bot = createMockBot();

    const result = await handler.transcribe(bot, 'file-123');
    expect(result).toBeNull();
  });

  it('returns null when getFileLink throws', async () => {
    const bot = {
      telegram: {
        getFileLink: jest.fn().mockRejectedValue(new Error('Telegram API error')),
      },
    };

    const result = await handler.transcribe(bot as any, 'bad-file');
    expect(result).toBeNull();
  });

  it('returns null when transcription service throws', async () => {
    mockTranscriptionService.transcribe.mockRejectedValue(new Error('Whisper failed'));
    const bot = createMockBot();

    const result = await handler.transcribe(bot, 'file-123');
    expect(result).toBeNull();
  });

  it('always cleans up temp file', async () => {
    const fs = require('node:fs');
    mockTranscriptionService.transcribe.mockRejectedValue(new Error('fail'));
    const bot = createMockBot();

    await handler.transcribe(bot, 'file-123');

    expect(fs.promises.unlink).toHaveBeenCalledWith(expect.stringContaining('argus-tg-voice-'));
  });
});
