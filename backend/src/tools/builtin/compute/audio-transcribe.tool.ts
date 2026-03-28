import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';
import { TranscriptionService } from '../../../transcription/transcription.service';

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const MAX_OUTPUT_LENGTH = 15_000;
const SUPPORTED_EXTENSIONS = new Set([
  '.wav', '.mp3', '.m4a', '.ogg', '.flac', '.webm', '.aac', '.wma', '.opus',
]);
const BLOCKED_PATH_PATTERNS = [
  /\.ssh/i, /\.env/i, /\.pem$/i, /\.key$/i, /id_rsa/i, /id_ed25519/i,
  /\.gnupg/i, /\.aws/i, /\.docker\/config/i, /\/etc\/shadow/i, /\/etc\/passwd/i,
];

// ─── Tool ────────────────────────────────────────────────────────────────────

@Injectable()
export class AudioTranscribeTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(AudioTranscribeTool.name);

  readonly definition: ToolDefinition = {
    name: 'audio_transcribe',
    description:
      'Transcribe audio or video files to text using Whisper AI (runs locally, no API needed). ' +
      'The model is downloaded automatically on first use (~150MB). ' +
      'Supports: WAV, MP3, M4A, OGG, FLAC, WebM, AAC, WMA, OPUS.\n\n' +
      'Use when the user asks to transcribe audio, voice messages, podcasts, meetings, or any spoken content. ' +
      'Returns the full transcription text.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the audio file (absolute or relative to workspace).',
        },
        language: {
          type: 'string',
          description:
            'Language code for better accuracy (e.g. "ru", "en", "de", "fr", "es", "zh", "ja"). ' +
            'Omit or "auto" for automatic detection.',
        },
      },
      required: ['path'],
    },
    safety: 'safe',
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly transcriptionService: TranscriptionService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.registry.register(this);
    this.logger.log(
      `audio_transcribe registered (model=${this.transcriptionService.modelName}, enabled=${this.transcriptionService.enabled})`,
    );
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    if (!this.transcriptionService.enabled) return 'Error: audio transcription is disabled.';

    const rawPath = String(args.path ?? '').trim();
    if (!rawPath) return 'Error: "path" is required.';

    const language = String(args.language ?? '').trim().toLowerCase();

    // ── Resolve & validate path ──────────────────────────────────────────
    const resolved = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(process.cwd(), rawPath);

    for (const pattern of BLOCKED_PATH_PATTERNS) {
      if (pattern.test(resolved)) {
        return `Error: access to "${rawPath}" is blocked for security.`;
      }
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(resolved);
    } catch {
      return `Error: file not found: "${rawPath}"`;
    }

    if (stat.isDirectory()) return 'Error: path is a directory, not an audio file.';
    if (stat.size === 0) return 'Error: file is empty.';
    if (stat.size > MAX_FILE_SIZE) {
      return `Error: file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 100MB).`;
    }

    const ext = path.extname(resolved).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return `Error: unsupported format "${ext}". Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`;
    }

    // ── Transcribe via shared service ────────────────────────────────────
    try {
      const result = await this.transcriptionService.transcribe(resolved, language);

      if (!result.text) {
        return 'Transcription completed but no speech was detected in the audio.';
      }

      const elapsed = (result.durationMs / 1000).toFixed(1);
      const fileSizeMb = (stat.size / 1024 / 1024).toFixed(1);
      const output = [
        `Transcription of "${path.basename(resolved)}" (${fileSizeMb}MB, ${elapsed}s):`,
        '',
        result.text,
      ].join('\n');

      return output.length > MAX_OUTPUT_LENGTH
        ? output.slice(0, MAX_OUTPUT_LENGTH - 20) + '\n\n[... truncated]'
        : output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`audio_transcribe failed: ${message}`);
      return `Error transcribing audio: ${message}`;
    }
  }
}
