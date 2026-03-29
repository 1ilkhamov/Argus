import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { diskStorage } from 'multer';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

import { AuthenticatedUserGuard } from '../common/guards/authenticated-user.guard';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { TranscriptionService } from '../transcription/transcription.service';
import { ChatService } from './chat.service';
import type {
  ChatResponseDto,
  ConversationPreviewDto,
  ConversationResponseDto,
  MessageResponseDto,
  StreamEventDto,
  VoiceChatResponseDto,
} from './dto/chat-response.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { VoiceMessageDto } from './dto/voice-message.dto';

// ─── Voice upload config ─────────────────────────────────────────────────────

const MAX_AUDIO_SIZE = 100 * 1024 * 1024; // 100 MB
const ALLOWED_AUDIO_MIMETYPES = new Set([
  'audio/wav', 'audio/x-wav', 'audio/wave',
  'audio/mpeg', 'audio/mp3',
  'audio/mp4', 'audio/x-m4a', 'audio/aac',
  'audio/ogg', 'audio/opus', 'audio/vorbis',
  'audio/flac', 'audio/x-flac',
  'audio/webm',
  'audio/x-ms-wma',
  'application/ogg', // some clients send ogg as application/ogg
  'video/webm',      // webm audio files sometimes have video/* mime
]);

const voiceStorage = diskStorage({
  destination: os.tmpdir(),
  filename: (_req, _file, cb) => {
    cb(null, `argus-voice-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  },
});

@UseGuards(AuthenticatedUserGuard, RateLimitGuard)
@Controller('chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly transcriptionService: TranscriptionService,
  ) {}

  @Post('messages')
  @HttpCode(HttpStatus.OK)
  async sendMessage(@Body() dto: SendMessageDto, @Req() req: Request): Promise<ChatResponseDto> {
    const { scopeKey } = req.identity!;
    const { conversation, assistantMessage } = await this.chatService.sendMessage(dto.conversationId, dto.content, {
      mode: dto.mode,
      scopeKey,
    });

    return {
      conversationId: conversation.id,
      message: {
        id: assistantMessage.id,
        conversationId: conversation.id,
        role: assistantMessage.role,
        content: assistantMessage.content,
        createdAt: assistantMessage.createdAt.toISOString(),
      },
    };
  }

  @Post('messages/stream')
  @HttpCode(HttpStatus.OK)
  async streamMessage(@Body() dto: SendMessageDto, @Req() req: Request, @Res() res: Response): Promise<void> {
    const { scopeKey } = req.identity!;
    const abortController = new AbortController();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    let clientDisconnected = false;
    let activeConversationId = dto.conversationId;
    let activeMessageId: string | undefined;

    res.on('close', () => {
      clientDisconnected = true;
      abortController.abort();
    });

    try {
      for await (const { chunk, conversationId, messageId } of this.chatService.streamMessage(
        dto.conversationId,
        dto.content,
        {
          mode: dto.mode,
          scopeKey,
          signal: abortController.signal,
        },
      )) {
        activeConversationId = conversationId;
        activeMessageId = messageId;

        if (clientDisconnected) {
          this.logger.debug(`Client disconnected during stream for ${conversationId}`);
          break;
        }

        let event: StreamEventDto;

        if (chunk.toolEvent) {
          event = {
            event: chunk.toolEvent.type === 'tool_start' ? 'tool_start' : 'tool_end',
            data: '',
            conversationId,
            messageId,
            toolName: chunk.toolEvent.name,
            ...(chunk.toolEvent.type === 'tool_end' && {
              toolDurationMs: chunk.toolEvent.durationMs,
              toolSuccess: chunk.toolEvent.success,
            }),
          };
        } else if (chunk.done) {
          event = { event: 'done', data: '', conversationId, messageId };
        } else {
          event = { event: 'token', data: chunk.content, conversationId, messageId };
        }

        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      const isAbort = error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted'));
      if (isAbort || clientDisconnected) {
        this.logger.debug(`Stream aborted for ${activeConversationId ?? 'unknown'}`);
      } else {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`Stream error: ${message}`);
        const errorEvent: StreamEventDto = {
          event: 'error',
          data: message,
          conversationId: activeConversationId,
          messageId: activeMessageId,
        };
        res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
      }
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
  }

  @Get('conversations')
  async getConversations(@Req() req: Request): Promise<ConversationPreviewDto[]> {
    const { scopeKey } = req.identity!;
    const conversations = await this.chatService.getAllConversations(scopeKey);
    return conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      messageCount: conversation.messageCount,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
    }));
  }

  @Get('conversations/:id')
  async getConversation(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request): Promise<ConversationResponseDto> {
    const conversation = await this.chatService.getConversation(id, req.identity?.scopeKey);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }

    return {
      id: conversation.id,
      title: conversation.title,
      messages: conversation.messages.map(
        (message): MessageResponseDto => ({
          id: message.id,
          conversationId: message.conversationId,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt.toISOString(),
        }),
      ),
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
    };
  }

  @Delete('conversations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteConversation(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request): Promise<void> {
    const deleted = await this.chatService.deleteConversation(id, req.identity?.scopeKey);
    if (!deleted) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }
  }

  // ─── Voice message endpoints ───────────────────────────────────────

  @Post('voice')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('audio', {
    storage: voiceStorage,
    limits: { fileSize: MAX_AUDIO_SIZE },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_AUDIO_MIMETYPES.has(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new BadRequestException(`Unsupported audio format: ${file.mimetype}. Send audio/* files.`), false);
      }
    },
  }))
  async voiceMessage(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: VoiceMessageDto,
    @Req() req: Request,
  ): Promise<VoiceChatResponseDto> {
    if (!file) {
      throw new BadRequestException('No audio file provided. Send a file in the "audio" field.');
    }

    const { scopeKey } = req.identity!;

    try {
      // 1. Transcribe
      const transcription = await this.transcriptionService.transcribe(
        file.path,
        dto.language,
      );

      if (!transcription.text) {
        throw new BadRequestException('No speech detected in the audio file.');
      }

      this.logger.log(
        `Voice transcribed (${transcription.durationMs}ms, ${(file.size / 1024).toFixed(0)}KB): "${transcription.text.slice(0, 80)}..."`,
      );

      // 2. Pass transcription to chat as a normal message
      const { conversation, assistantMessage } = await this.chatService.sendMessage(
        dto.conversationId,
        transcription.text,
        { mode: dto.mode, scopeKey },
      );

      return {
        conversationId: conversation.id,
        transcription: transcription.text,
        transcriptionDurationMs: transcription.durationMs,
        message: {
          id: assistantMessage.id,
          conversationId: conversation.id,
          role: assistantMessage.role,
          content: assistantMessage.content,
          createdAt: assistantMessage.createdAt.toISOString(),
        },
      };
    } finally {
      await fs.unlink(file.path).catch(() => {});
    }
  }

  @Post('voice/stream')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('audio', {
    storage: voiceStorage,
    limits: { fileSize: MAX_AUDIO_SIZE },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_AUDIO_MIMETYPES.has(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new BadRequestException(`Unsupported audio format: ${file.mimetype}. Send audio/* files.`), false);
      }
    },
  }))
  async voiceStreamMessage(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: VoiceMessageDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!file) {
      throw new BadRequestException('No audio file provided. Send a file in the "audio" field.');
    }

    const { scopeKey } = req.identity!;
    const abortController = new AbortController();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    let clientDisconnected = false;
    res.on('close', () => {
      clientDisconnected = true;
      abortController.abort();
    });

    try {
      // 1. Transcribe
      const transcription = await this.transcriptionService.transcribe(
        file.path,
        dto.language,
      );

      if (!transcription.text) {
        const errorEvent: StreamEventDto = { event: 'error', data: 'No speech detected in the audio file.' };
        res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
        return;
      }

      this.logger.log(
        `Voice transcribed for stream (${transcription.durationMs}ms): "${transcription.text.slice(0, 80)}..."`,
      );

      // 2. Send transcription event to client first
      const transcriptionEvent: StreamEventDto = {
        event: 'transcription',
        data: transcription.text,
      };
      res.write(`data: ${JSON.stringify(transcriptionEvent)}\n\n`);

      if (clientDisconnected) return;

      // 3. Stream assistant response
      for await (const { chunk, conversationId, messageId } of this.chatService.streamMessage(
        dto.conversationId,
        transcription.text,
        {
          mode: dto.mode,
          scopeKey,
          signal: abortController.signal,
        },
      )) {
        if (clientDisconnected) break;

        let event: StreamEventDto;

        if (chunk.toolEvent) {
          event = {
            event: chunk.toolEvent.type === 'tool_start' ? 'tool_start' : 'tool_end',
            data: '',
            conversationId,
            messageId,
            toolName: chunk.toolEvent.name,
            ...(chunk.toolEvent.type === 'tool_end' && {
              toolDurationMs: chunk.toolEvent.durationMs,
              toolSuccess: chunk.toolEvent.success,
            }),
          };
        } else if (chunk.done) {
          event = { event: 'done', data: '', conversationId, messageId };
        } else {
          event = { event: 'token', data: chunk.content, conversationId, messageId };
        }

        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      const isAbort = error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted'));
      if (!isAbort && !clientDisconnected) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`Voice stream error: ${message}`);
        const errorEvent: StreamEventDto = { event: 'error', data: message };
        res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
      }
    } finally {
      await fs.unlink(file.path).catch(() => {});
      if (!res.writableEnded) {
        res.end();
      }
    }
  }
}
