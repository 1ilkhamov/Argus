import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'Xenova/whisper-base';
const CONVERSION_TIMEOUT_MS = 120_000;

export interface TranscriptionResult {
  text: string;
  durationMs: number;
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class TranscriptionService implements OnModuleInit {
  private readonly logger = new Logger(TranscriptionService.name);
  readonly modelName: string;
  readonly enabled: boolean;

  private transcriber: any = null;
  private loadingPromise: Promise<void> | null = null;
  private converterType: 'ffmpeg' | 'afconvert' | null = null;

  constructor(private readonly configService: ConfigService) {
    this.modelName = this.configService.get<string>(
      'tools.audioTranscribe.model',
      DEFAULT_MODEL,
    );
    this.enabled = this.configService.get<boolean>(
      'tools.audioTranscribe.enabled',
      true,
    );
  }

  async onModuleInit(): Promise<void> {
    this.converterType = await detectAudioConverter();
    this.logger.log(
      `TranscriptionService init (model=${this.modelName}, converter=${this.converterType ?? 'none'}, enabled=${this.enabled})`,
    );
  }

  /**
   * Transcribe an audio file to text.
   *
   * @param filePath — absolute path to the audio file
   * @param language — language code or 'auto' (default: auto-detect)
   * @returns transcription text and elapsed time
   * @throws Error if transcription fails or service is disabled
   */
  async transcribe(filePath: string, language?: string): Promise<TranscriptionResult> {
    if (!this.enabled) {
      throw new Error('Audio transcription is disabled.');
    }

    await this.ensureModelLoaded();

    const ext = path.extname(filePath).toLowerCase();
    const audioSamples = await this.loadAudioSamples(filePath, ext);

    const startTime = Date.now();
    const options: Record<string, unknown> = {
      return_timestamps: false,
      chunk_length_s: 30,
      stride_length_s: 5,
    };

    const lang = (language ?? '').trim().toLowerCase();
    if (lang && lang !== 'auto') {
      options.language = lang;
      options.task = 'transcribe';
    }

    const result = await this.transcriber(audioSamples, options);
    const durationMs = Date.now() - startTime;
    const text = String(result?.text ?? '').trim();

    return { text, durationMs };
  }

  /** Check if the service is ready (model loaded). */
  isReady(): boolean {
    return this.transcriber !== null;
  }

  /** Check if an audio converter (ffmpeg/afconvert) is available. */
  hasConverter(): boolean {
    return this.converterType !== null;
  }

  // ─── Model loading ─────────────────────────────────────────────────────

  private async ensureModelLoaded(): Promise<void> {
    if (this.transcriber) return;

    if (this.loadingPromise) {
      await this.loadingPromise;
      return;
    }

    this.loadingPromise = this.loadModel();
    try {
      await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
  }

  private async loadModel(): Promise<void> {
    this.logger.log(`Loading Whisper model: ${this.modelName} (first run downloads ~150MB)...`);

    const transformers = await import('@xenova/transformers');
    transformers.env.allowLocalModels = false;

    this.transcriber = await transformers.pipeline(
      'automatic-speech-recognition',
      this.modelName,
    );

    this.logger.log(`Whisper model loaded: ${this.modelName}`);
  }

  // ─── Audio loading ─────────────────────────────────────────────────────

  private async loadAudioSamples(
    filePath: string,
    ext: string,
  ): Promise<Float32Array> {
    if (this.converterType) {
      return this.convertAndParse(filePath);
    }

    if (ext !== '.wav') {
      throw new Error(
        `Cannot process ${ext} files without ffmpeg. ` +
        'Install ffmpeg: brew install ffmpeg (macOS) or apt install ffmpeg (Linux).',
      );
    }

    return this.parseWavFile(filePath);
  }

  private async convertAndParse(filePath: string): Promise<Float32Array> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-audio-'));
    const tempWav = path.join(tempDir, 'audio.wav');

    try {
      if (this.converterType === 'ffmpeg') {
        await execFileAsync('ffmpeg', [
          '-i', filePath,
          '-ar', '16000',
          '-ac', '1',
          '-sample_fmt', 's16',
          '-f', 'wav',
          '-y',
          tempWav,
        ], { timeout: CONVERSION_TIMEOUT_MS });
      } else {
        await execFileAsync('afconvert', [
          '-d', 'LEI16',
          '-c', '1',
          '-r', '16000',
          '-f', 'WAVE',
          filePath,
          tempWav,
        ], { timeout: CONVERSION_TIMEOUT_MS });
      }

      return this.parseWavFile(tempWav);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async parseWavFile(filePath: string): Promise<Float32Array> {
    const buffer = await fs.readFile(filePath);

    if (buffer.length < 44) {
      throw new Error('WAV file is too small to contain valid audio data.');
    }

    const riff = buffer.toString('ascii', 0, 4);
    const wave = buffer.toString('ascii', 8, 12);
    if (riff !== 'RIFF' || wave !== 'WAVE') {
      throw new Error('Not a valid WAV file.');
    }

    let sampleRate = 16000;
    let numChannels = 1;
    let bitsPerSample = 16;
    let dataOffset = -1;
    let dataSize = 0;

    let offset = 12;
    while (offset + 8 <= buffer.length) {
      const chunkId = buffer.toString('ascii', offset, offset + 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);

      if (chunkId === 'fmt ') {
        numChannels = buffer.readUInt16LE(offset + 10);
        sampleRate = buffer.readUInt32LE(offset + 12);
        bitsPerSample = buffer.readUInt16LE(offset + 22);
      }

      if (chunkId === 'data') {
        dataOffset = offset + 8;
        dataSize = chunkSize;
        break;
      }

      offset += 8 + chunkSize;
      if (chunkSize % 2 !== 0) offset += 1;
    }

    if (dataOffset < 0 || dataSize === 0) {
      throw new Error('WAV file contains no audio data.');
    }

    const actualDataSize = Math.min(dataSize, buffer.length - dataOffset);
    const bytesPerSample = bitsPerSample / 8;
    const totalSamples = Math.floor(actualDataSize / bytesPerSample);
    const monoSamples = Math.floor(totalSamples / numChannels);

    const samples = new Float32Array(monoSamples);

    for (let i = 0; i < monoSamples; i++) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        const byteIndex = dataOffset + (i * numChannels + ch) * bytesPerSample;

        if (bitsPerSample === 16) {
          sum += buffer.readInt16LE(byteIndex) / 32768;
        } else if (bitsPerSample === 32) {
          sum += buffer.readInt32LE(byteIndex) / 2147483648;
        } else if (bitsPerSample === 8) {
          sum += (buffer.readUInt8(byteIndex) - 128) / 128;
        }
      }
      samples[i] = sum / numChannels;
    }

    if (sampleRate !== 16000) {
      return resampleLinear(samples, sampleRate, 16000);
    }

    return samples;
  }
}

// ─── Utility functions ──────────────────────────────────────────────────────

async function detectAudioConverter(): Promise<'ffmpeg' | 'afconvert' | null> {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 });
    return 'ffmpeg';
  } catch {
    // not available
  }

  if (process.platform === 'darwin') {
    try {
      await execFileAsync('which', ['afconvert'], { timeout: 5000 });
      return 'afconvert';
    } catch {
      // not available
    }
  }

  return null;
}

function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return samples;

  const ratio = fromRate / toRate;
  const newLength = Math.round(samples.length / ratio);
  const result = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const lower = Math.floor(srcIndex);
    const upper = Math.min(lower + 1, samples.length - 1);
    const frac = srcIndex - lower;
    result[i] = samples[lower]! * (1 - frac) + samples[upper]! * frac;
  }

  return result;
}
