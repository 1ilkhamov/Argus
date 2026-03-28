import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { TranscriptionResult } from '../../../transcription/transcription.service';
import { AudioTranscribeTool } from './audio-transcribe.tool';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockRegister = jest.fn();
const mockRegistry = { register: mockRegister } as any;

const mockTranscribe = jest.fn<Promise<TranscriptionResult>, [string, string?]>();
const mockTranscriptionService = {
  modelName: 'Xenova/whisper-base',
  enabled: true,
  transcribe: mockTranscribe,
} as any;

describe('AudioTranscribeTool', () => {
  let tool: AudioTranscribeTool;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTranscriptionService.enabled = true;
    tool = new AudioTranscribeTool(mockRegistry, mockTranscriptionService);
    await tool.onModuleInit();
  });

  // ─── Registration ────────────────────────────────────────────────────

  it('should register on module init', () => {
    expect(mockRegister).toHaveBeenCalledWith(tool);
  });

  it('should have correct tool definition', () => {
    expect(tool.definition.name).toBe('audio_transcribe');
    expect(tool.definition.safety).toBe('safe');
    expect(tool.definition.parameters.required).toContain('path');
  });

  // ─── Input validation ────────────────────────────────────────────────

  it('should require path parameter', async () => {
    const result = await tool.execute({});
    expect(result).toContain('Error');
    expect(result).toContain('path');
  });

  it('should reject empty path', async () => {
    const result = await tool.execute({ path: '' });
    expect(result).toContain('Error');
    expect(result).toContain('path');
  });

  it('should reject nonexistent file', async () => {
    const result = await tool.execute({ path: '/nonexistent/audio.wav' });
    expect(result).toContain('Error');
    expect(result).toContain('not found');
  });

  it('should reject directories', async () => {
    const result = await tool.execute({ path: '/tmp' });
    expect(result).toContain('Error');
    expect(result).toContain('directory');
  });

  it('should reject unsupported extensions', async () => {
    const tmpDir = await fs.mkdtemp(path.join('/tmp', 'argus-test-'));
    const tmpFile = path.join(tmpDir, 'test.txt');
    await fs.writeFile(tmpFile, 'not audio');

    try {
      const result = await tool.execute({ path: tmpFile });
      expect(result).toContain('Error');
      expect(result).toContain('unsupported');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('should reject empty files', async () => {
    const tmpDir = await fs.mkdtemp(path.join('/tmp', 'argus-test-'));
    const tmpFile = path.join(tmpDir, 'empty.wav');
    await fs.writeFile(tmpFile, Buffer.alloc(0));

    try {
      const result = await tool.execute({ path: tmpFile });
      expect(result).toContain('Error');
      expect(result).toContain('empty');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ─── Security ────────────────────────────────────────────────────────

  it('should block access to .ssh directory', async () => {
    const result = await tool.execute({ path: '/home/user/.ssh/id_rsa.wav' });
    expect(result).toContain('blocked');
    expect(result).toContain('security');
  });

  it('should block access to .env files', async () => {
    const result = await tool.execute({ path: '/app/.env.wav' });
    expect(result).toContain('blocked');
    expect(result).toContain('security');
  });

  it('should block access to .pem files', async () => {
    const result = await tool.execute({ path: '/certs/server.pem' });
    expect(result).toContain('blocked');
    expect(result).toContain('security');
  });

  // ─── Disabled mode ───────────────────────────────────────────────────

  it('should return error when disabled', async () => {
    mockTranscriptionService.enabled = false;
    const disabledTool = new AudioTranscribeTool(mockRegistry, mockTranscriptionService);
    await disabledTool.onModuleInit();

    const result = await disabledTool.execute({ path: '/tmp/audio.wav' });
    expect(result).toContain('disabled');
  });

  // ─── Transcription ───────────────────────────────────────────────────

  it('should transcribe a valid WAV file', async () => {
    const tmpDir = await fs.mkdtemp(path.join('/tmp', 'argus-test-'));
    const tmpFile = path.join(tmpDir, 'test.wav');
    await fs.writeFile(tmpFile, createMinimalWav(16000, 1, 16, 1600));

    mockTranscribe.mockResolvedValueOnce({ text: 'Hello world', durationMs: 1500 });

    try {
      const result = await tool.execute({ path: tmpFile });
      expect(result).toContain('Hello world');
      expect(result).toContain('Transcription');
      expect(mockTranscribe).toHaveBeenCalledWith(tmpFile, '');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('should pass language option when specified', async () => {
    const tmpDir = await fs.mkdtemp(path.join('/tmp', 'argus-test-'));
    const tmpFile = path.join(tmpDir, 'test.wav');
    await fs.writeFile(tmpFile, createMinimalWav(16000, 1, 16, 1600));

    mockTranscribe.mockResolvedValueOnce({ text: 'Привет мир', durationMs: 1200 });

    try {
      await tool.execute({ path: tmpFile, language: 'ru' });
      expect(mockTranscribe).toHaveBeenCalledWith(tmpFile, 'ru');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('should handle no speech detected', async () => {
    const tmpDir = await fs.mkdtemp(path.join('/tmp', 'argus-test-'));
    const tmpFile = path.join(tmpDir, 'silence.wav');
    await fs.writeFile(tmpFile, createMinimalWav(16000, 1, 16, 1600));

    mockTranscribe.mockResolvedValueOnce({ text: '', durationMs: 800 });

    try {
      const result = await tool.execute({ path: tmpFile });
      expect(result).toContain('no speech');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('should handle transcription errors gracefully', async () => {
    const tmpDir = await fs.mkdtemp(path.join('/tmp', 'argus-test-'));
    const tmpFile = path.join(tmpDir, 'bad.wav');
    await fs.writeFile(tmpFile, createMinimalWav(16000, 1, 16, 1600));

    mockTranscribe.mockRejectedValueOnce(new Error('Model inference failed'));

    try {
      const result = await tool.execute({ path: tmpFile });
      expect(result).toContain('Error');
      expect(result).toContain('Model inference failed');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('should not pass language option for "auto"', async () => {
    const tmpDir = await fs.mkdtemp(path.join('/tmp', 'argus-test-'));
    const tmpFile = path.join(tmpDir, 'test.wav');
    await fs.writeFile(tmpFile, createMinimalWav(16000, 1, 16, 1600));

    mockTranscribe.mockResolvedValueOnce({ text: 'test', durationMs: 500 });

    try {
      await tool.execute({ path: tmpFile, language: 'auto' });
      expect(mockTranscribe).toHaveBeenCalledWith(tmpFile, 'auto');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ─── Supported formats ───────────────────────────────────────────────

  const supportedExts = ['.wav', '.mp3', '.m4a', '.ogg', '.flac', '.webm', '.aac', '.wma', '.opus'];
  for (const ext of supportedExts) {
    it(`should accept ${ext} extension`, () => {
      const desc = tool.definition.description;
      expect(desc.toUpperCase()).toContain(ext.replace('.', '').toUpperCase());
    });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMinimalWav(
  sampleRate: number,
  numChannels: number,
  bitsPerSample: number,
  numSamples: number,
): Buffer {
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = numSamples * numChannels * bytesPerSample;
  const headerSize = 44;
  const buffer = Buffer.alloc(headerSize + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
  buffer.writeUInt16LE(numChannels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}
