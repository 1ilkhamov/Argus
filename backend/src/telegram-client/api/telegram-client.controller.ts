import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { AdminApiKeyGuard } from '../../common/guards/admin-api-key.guard';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { TelegramClientService } from '../telegram-client.service';
import { TelegramClientRepository } from '../telegram-client.repository';
import type {
  TgClientStatus,
  TgClientSendCodeResult,
  TgClientSignInResult,
  TgMonitoredChat,
  TgDialogInfo,
  TgQrTokenResult,
  TgQrCheckResult,
} from '../telegram-client.types';

@UseGuards(AdminApiKeyGuard, RateLimitGuard)
@Controller('telegram-client')
export class TelegramClientController {
  constructor(
    private readonly clientService: TelegramClientService,
    private readonly repository: TelegramClientRepository,
  ) {}

  // ─── Status & lifecycle ─────────────────────────────────────────────────

  @Get('status')
  async getStatus(): Promise<TgClientStatus> {
    return this.clientService.getStatus();
  }

  @Post('start')
  async start(): Promise<TgClientStatus> {
    await this.clientService.connect();
    return this.clientService.getStatus();
  }

  @Post('stop')
  async stop(): Promise<TgClientStatus> {
    await this.clientService.disconnect();
    return this.clientService.getStatus();
  }

  @Post('restart')
  async restart(): Promise<TgClientStatus> {
    return this.clientService.restart();
  }

  // ─── Auth flow ──────────────────────────────────────────────────────────

  @Post('auth/send-code')
  async sendCode(@Body() body: { phone: string }): Promise<TgClientSendCodeResult> {
    if (!body.phone?.trim()) {
      throw new Error('Phone number is required.');
    }
    return this.clientService.sendCode(body.phone.trim());
  }

  @Post('auth/resend-code')
  async resendCode(): Promise<TgClientSendCodeResult> {
    return this.clientService.resendCode();
  }

  @Post('auth/qr-token')
  async getQrToken(): Promise<TgQrTokenResult> {
    return this.clientService.getQrToken();
  }

  @Get('auth/qr-check')
  async checkQrLogin(): Promise<TgQrCheckResult> {
    return this.clientService.checkQrLogin();
  }

  @Post('auth/sign-in')
  async signIn(
    @Body() body: { phone: string; code: string; phoneCodeHash: string },
  ): Promise<TgClientSignInResult> {
    if (!body.phone || !body.code || !body.phoneCodeHash) {
      throw new Error('phone, code, and phoneCodeHash are required.');
    }
    return this.clientService.signIn(body.phone, body.code, body.phoneCodeHash);
  }

  @Post('auth/2fa')
  async submit2FA(@Body() body: { password: string }): Promise<TgClientSignInResult> {
    if (!body.password) {
      throw new Error('password is required.');
    }
    return this.clientService.submit2FA(body.password);
  }

  // ─── Dialogs ────────────────────────────────────────────────────────────

  @Get('dialogs')
  async getDialogs(): Promise<TgDialogInfo[]> {
    return this.clientService.getDialogs(50);
  }

  // ─── Messages (debug) ──────────────────────────────────────────────────

  @Get('messages/:chatId')
  async getMessages(@Param('chatId') chatId: string): Promise<any[]> {
    return this.clientService.getMessages(chatId, 10);
  }

  // ─── Monitored chats CRUD ──────────────────────────────────────────────

  @Get('chats')
  async listChats(): Promise<TgMonitoredChat[]> {
    return this.repository.findAll();
  }

  @Post('chats')
  async addChat(
    @Body() body: { chatId: string; chatTitle?: string; chatType?: string; mode?: string; cooldownSeconds?: number; systemNote?: string },
  ): Promise<TgMonitoredChat> {
    if (!body.chatId?.trim()) {
      throw new Error('chatId is required.');
    }

    const existing = await this.repository.findByChatId(body.chatId);
    if (existing) {
      throw new Error(`Chat ${body.chatId} is already monitored.`);
    }

    const chat = await this.repository.create({
      chatId: body.chatId.trim(),
      chatTitle: body.chatTitle || body.chatId,
      chatType: (body.chatType as any) || 'unknown',
      mode: (body.mode as any) || 'auto',
      cooldownSeconds: body.cooldownSeconds,
      systemNote: body.systemNote,
    });

    // Fire-and-forget: sync recent message history for this chat
    this.clientService.syncChatHistory(chat.chatId).catch((err) => {
      // Non-critical: sync may fail if client is not connected
      void err;
    });

    return chat;
  }

  @Post('chats/:id/sync')
  async syncChat(@Param('id') id: string): Promise<{ synced: number }> {
    const existing = await this.repository.findById(id);
    if (!existing) throw new Error('Chat not found');
    const synced = await this.clientService.syncChatHistory(existing.chatId);
    return { synced };
  }

  @Patch('chats/:id')
  async updateChat(
    @Param('id') id: string,
    @Body() body: { chatTitle?: string; chatType?: string; mode?: string; cooldownSeconds?: number; systemNote?: string },
  ): Promise<TgMonitoredChat | null> {
    const existing = await this.repository.findById(id);
    if (!existing) return null;

    await this.repository.update(id, {
      chatTitle: body.chatTitle,
      chatType: body.chatType as any,
      mode: body.mode as any,
      cooldownSeconds: body.cooldownSeconds,
      systemNote: body.systemNote,
    });

    return (await this.repository.findById(id)) ?? null;
  }

  @Delete('chats/:id')
  async deleteChat(@Param('id') id: string): Promise<{ deleted: boolean }> {
    const deleted = await this.repository.delete(id);
    return { deleted };
  }
}
