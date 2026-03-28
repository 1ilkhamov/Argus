import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Telegraf } from 'telegraf';

import { TranscriptionService } from '../../transcription/transcription.service';

/**
 * Downloads Telegram voice/audio messages, transcribes them via TranscriptionService,
 * and returns the transcribed text.
 */
@Injectable()
export class TelegramVoiceHandler {
  private readonly logger = new Logger(TelegramVoiceHandler.name);

  constructor(private readonly transcriptionService: TranscriptionService) {}

  /**
   * Download a Telegram voice or audio file and transcribe it.
   * @returns transcribed text, or null if transcription failed
   */
  async transcribe(bot: Telegraf, fileId: string, language?: string): Promise<string | null> {
    let tempPath: string | undefined;

    try {
      // Get file link from Telegram
      const fileLink = await bot.telegram.getFileLink(fileId);
      const url = typeof fileLink === 'string' ? fileLink : fileLink.href;

      // Download to temp file
      tempPath = path.join(os.tmpdir(), `argus-tg-voice-${Date.now()}-${Math.random().toString(36).slice(2)}.ogg`);
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to download voice file: ${response.statusText}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.promises.writeFile(tempPath, buffer);

      this.logger.debug(`Downloaded voice file: ${tempPath} (${buffer.length} bytes)`);

      // Transcribe
      const startTime = Date.now();
      const result = await this.transcriptionService.transcribe(tempPath, language);
      const durationMs = Date.now() - startTime;

      this.logger.debug(`Transcription completed in ${durationMs}ms: "${result.text.slice(0, 100)}"`);

      return result.text.trim() || null;
    } catch (err) {
      this.logger.error(`Voice transcription failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      // Always clean up temp file
      if (tempPath) {
        fs.promises.unlink(tempPath).catch(() => {});
      }
    }
  }
}
