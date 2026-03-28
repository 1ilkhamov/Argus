import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl';

import { SettingsService } from '../settings/settings.service';
import type {
  TelegramClientConfig,
  TgClientAuthState,
  TgClientSendCodeResult,
  TgClientSignInResult,
  TgClientStatus,
  TgDialogInfo,
  TgQrTokenResult,
  TgQrCheckResult,
  CreateStoredMessageParams,
} from './telegram-client.types';
import { TG_CLIENT_SETTINGS } from './telegram-client.types';
import { TelegramClientRepository } from './telegram-client.repository';
import { TelegramClientMessagesRepository } from './telegram-client-messages.repository';

@Injectable()
export class TelegramClientService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramClientService.name);
  private client: TelegramClient | null = null;
  private authState: TgClientAuthState = { step: 'idle' };
  private currentUser: { id: string; firstName: string; username?: string } | null = null;
  private readonly config: TelegramClientConfig;

  /** Listeners set by TelegramClientListener */
  private messageHandler?: (event: any) => void;

  constructor(
    private readonly configService: ConfigService,
    private readonly settingsService: SettingsService,
    private readonly repository: TelegramClientRepository,
    private readonly messagesRepository: TelegramClientMessagesRepository,
  ) {
    this.config = this.configService.get<TelegramClientConfig>('telegramClient')!;
  }

  async onModuleInit(): Promise<void> {
    // Try auto-connect if session exists in DB (regardless of env flag)
    const session = await this.settingsService.getValue(TG_CLIENT_SETTINGS.SESSION);
    if (session) {
      try {
        await this.connect(session);
        this.logger.log('Telegram client auto-connected from saved session');
      } catch (err) {
        this.logger.warn(`Auto-connect failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (this.config.enabled) {
      this.logger.log('Telegram client enabled but no session — awaiting authorization');
    } else {
      this.logger.log('Telegram client: no saved session');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  getClient(): TelegramClient | null {
    return this.client;
  }

  isConnected(): boolean {
    return this.client?.connected ?? false;
  }

  getMyUserId(): string | null {
    return this.currentUser?.id ?? null;
  }

  getCurrentUser(): { id: string; firstName: string; username?: string } | null {
    return this.currentUser;
  }

  async getStatus(): Promise<TgClientStatus> {
    const chats = await this.repository.findActive();
    return {
      connected: this.isConnected(),
      authorized: this.authState.step === 'authorized',
      user: this.currentUser,
      monitoredChats: chats.length,
      authStep: this.authState.step,
    };
  }

  setMessageHandler(handler: (event: any) => void): void {
    this.messageHandler = handler;
  }

  // ─── Auth flow ──────────────────────────────────────────────────────────

  async sendCode(phone: string): Promise<TgClientSendCodeResult> {
    const { apiId, apiHash } = await this.resolveCredentials();

    if (!apiId || !apiHash) {
      throw new Error(
        'Telegram Client API credentials not configured. Set telegram_client.api_id and telegram_client.api_hash in Settings.',
      );
    }

    // Create a fresh client for auth
    const stringSession = new StringSession('');
    this.client = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 3,
    });

    await this.client.connect();

    const result = await this.client.invoke(
      new Api.auth.SendCode({
        phoneNumber: phone,
        apiId,
        apiHash,
        settings: new Api.CodeSettings({}),
      }),
    );

    const phoneCodeHash = (result as any).phoneCodeHash as string;
    const codeType = (result as any).type?.className ?? 'unknown';

    this.authState = {
      step: 'awaiting_code',
      phone,
      phoneCodeHash,
    };

    // Save phone for later
    await this.settingsService.set(TG_CLIENT_SETTINGS.PHONE, phone);

    this.logger.log(`Auth code sent to ${phone}, delivery type: ${codeType}, hash: ${phoneCodeHash.substring(0, 8)}...`);
    return { phoneCodeHash };
  }

  async resendCode(): Promise<TgClientSendCodeResult> {
    if (!this.client || this.authState.step !== 'awaiting_code') {
      throw new Error('No pending auth. Call sendCode first.');
    }

    const phone = this.authState.phone!;
    const oldHash = this.authState.phoneCodeHash!;

    const result = await this.client.invoke(
      new Api.auth.ResendCode({
        phoneNumber: phone,
        phoneCodeHash: oldHash,
      }),
    );

    const phoneCodeHash = (result as any).phoneCodeHash as string;
    const codeType = (result as any).type?.className ?? 'unknown';

    this.authState = {
      step: 'awaiting_code',
      phone,
      phoneCodeHash,
    };

    this.logger.log(`Auth code RESENT to ${phone}, delivery type: ${codeType}, hash: ${phoneCodeHash.substring(0, 8)}...`);
    return { phoneCodeHash };
  }

  // ─── QR Auth flow ─────────────────────────────────────────────────────

  async getQrToken(): Promise<TgQrTokenResult> {
    const { apiId, apiHash } = await this.resolveCredentials();

    if (!apiId || !apiHash) {
      throw new Error('Telegram Client API credentials not configured.');
    }

    // Create fresh client if not connected
    if (!this.client || !this.client.connected) {
      const stringSession = new StringSession('');
      this.client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
      });
      await this.client.connect();
    }

    const result = await this.client.invoke(
      new Api.auth.ExportLoginToken({
        apiId,
        apiHash,
        exceptIds: [],
      }),
    );

    if (result.className === 'auth.LoginTokenMigrateTo') {
      this.logger.log(`QR: migrating to DC ${(result as any).dcId}`);
      await (this.client as any)._switchDC((result as any).dcId);

      const migrated = await this.client.invoke(
        new Api.auth.ExportLoginToken({
          apiId,
          apiHash,
          exceptIds: [],
        }),
      );

      if (migrated.className === 'auth.LoginToken') {
        const token = Buffer.from((migrated as any).token).toString('base64url');
        const expiresIn = (migrated as any).expires - Math.floor(Date.now() / 1000);
        this.authState = { step: 'awaiting_qr' };
        this.logger.log('QR token generated (after DC migration)');
        return { qrUrl: `tg://login?token=${token}`, expiresIn };
      }
    }

    if (result.className === 'auth.LoginToken') {
      const token = Buffer.from((result as any).token).toString('base64url');
      const expiresIn = (result as any).expires - Math.floor(Date.now() / 1000);
      this.authState = { step: 'awaiting_qr' };
      this.logger.log('QR token generated');
      return { qrUrl: `tg://login?token=${token}`, expiresIn };
    }

    if (result.className === 'auth.LoginTokenSuccess') {
      const user = (result as any).authorization?.user;
      if (user) await this.finalizeAuth(user);
      return { qrUrl: '', expiresIn: 0 };
    }

    throw new Error('Unexpected response from Telegram QR export');
  }

  async checkQrLogin(): Promise<TgQrCheckResult> {
    if (!this.client || this.authState.step === 'authorized') {
      const status = await this.getStatus();
      if (status.authorized) return { status: 'authorized', user: status.user ?? undefined };
      return { status: 'expired' };
    }

    if (this.authState.step === 'awaiting_2fa') {
      return { status: 'requires_2fa' };
    }

    const { apiId, apiHash } = await this.resolveCredentials();

    try {
      const result = await this.client.invoke(
        new Api.auth.ExportLoginToken({
          apiId,
          apiHash,
          exceptIds: [],
        }),
      );

      if (result.className === 'auth.LoginTokenSuccess') {
        const user = (result as any).authorization?.user;
        if (user) {
          const finalResult = await this.finalizeAuth(user);
          return { status: 'authorized', user: finalResult.user };
        }
      }

      if (result.className === 'auth.LoginTokenMigrateTo') {
        await (this.client as any)._switchDC((result as any).dcId);
        const imported = await this.client.invoke(
          new Api.auth.ImportLoginToken({ token: (result as any).token }),
        );
        if (imported.className === 'auth.LoginTokenSuccess') {
          const user = (imported as any).authorization?.user;
          if (user) {
            const finalResult = await this.finalizeAuth(user);
            return { status: 'authorized', user: finalResult.user };
          }
        }
      }

      return { status: 'waiting' };
    } catch (err: any) {
      if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        this.authState = { step: 'awaiting_2fa' };
        return { status: 'requires_2fa' };
      }
      if (err.errorMessage === 'AUTH_TOKEN_EXPIRED') {
        return { status: 'expired' };
      }
      throw err;
    }
  }

  async signIn(phone: string, code: string, phoneCodeHash: string): Promise<TgClientSignInResult> {
    if (!this.client) {
      throw new Error('No active client. Call sendCode first.');
    }

    try {
      const result = await this.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: phone,
          phoneCodeHash,
          phoneCode: code,
        }),
      );

      // Success
      const user = (result as any).user;
      return this.finalizeAuth(user);
    } catch (err: any) {
      if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        this.authState = { ...this.authState, step: 'awaiting_2fa' };
        return { success: false, requires2FA: true };
      }
      throw err;
    }
  }

  async submit2FA(password: string): Promise<TgClientSignInResult> {
    if (!this.client) {
      throw new Error('No active client. Call sendCode first.');
    }

    // Use GramJS high-level signInWithPassword helper
    const result = await this.client.invoke(new Api.account.GetPassword());
    const algo = result.currentAlgo;
    if (!algo || !(algo instanceof Api.PasswordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow)) {
      throw new Error('Unsupported 2FA algorithm from Telegram.');
    }

    // Import the password computation helper from GramJS
    const { computeCheck } = await import('telegram/Password');
    const srpPassword = await computeCheck(result, password);

    const authResult = await this.client.invoke(
      new Api.auth.CheckPassword({ password: srpPassword }),
    );

    const user = (authResult as any).user;
    return this.finalizeAuth(user);
  }

  // ─── Connect / Disconnect ──────────────────────────────────────────────

  async connect(sessionString?: string): Promise<void> {
    const { apiId, apiHash } = await this.resolveCredentials();

    if (!apiId || !apiHash) {
      throw new Error('Telegram Client API credentials not configured.');
    }

    const session = sessionString || await this.settingsService.getValue(TG_CLIENT_SETTINGS.SESSION) || '';
    const stringSession = new StringSession(session);

    this.client = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 5,
    });

    await this.client.connect();

    // Verify authorization
    const me = await this.client.getMe() as any;
    if (!me) {
      throw new Error('Client connected but not authorized. Run auth flow.');
    }

    this.currentUser = {
      id: String(me.id),
      firstName: me.firstName || '',
      username: me.username || undefined,
    };
    this.authState = { step: 'authorized' };

    // Register message handler if set
    if (this.messageHandler) {
      const { NewMessage } = await import('telegram/events');
      this.client.addEventHandler(this.messageHandler, new NewMessage({}));
    }

    this.logger.log(`Connected as ${this.currentUser.firstName} (@${this.currentUser.username || 'N/A'})`);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch {
        // ignore
      }
      this.client = null;
      this.currentUser = null;
      this.authState = { step: 'idle' };
      this.logger.log('Telegram client disconnected');
    }
  }

  async restart(): Promise<TgClientStatus> {
    await this.disconnect();

    const session = await this.settingsService.getValue(TG_CLIENT_SETTINGS.SESSION);
    if (session) {
      await this.connect(session);
    }

    return this.getStatus();
  }

  // ─── Dialogs ────────────────────────────────────────────────────────────

  async getDialogs(limit = 50): Promise<TgDialogInfo[]> {
    if (!this.client || !this.isConnected()) {
      throw new Error('Telegram client is not connected.');
    }

    const dialogs = await this.client.getDialogs({ limit });
    const result: TgDialogInfo[] = [];

    for (const dialog of dialogs) {
      const entity = dialog.entity;
      if (!entity) continue;

      let type: TgDialogInfo['type'] = 'unknown';
      if (entity instanceof Api.User) type = 'user';
      else if (entity instanceof Api.Chat) type = 'group';
      else if (entity instanceof Api.Channel) {
        type = (entity as any).megagroup ? 'supergroup' : 'channel';
      }

      result.push({
        chatId: String(dialog.id),
        title: dialog.title || (entity instanceof Api.User ? `${(entity as any).firstName || ''} ${(entity as any).lastName || ''}`.trim() : ''),
        type,
        unreadCount: dialog.unreadCount,
        lastMessageDate: dialog.date ? new Date(dialog.date * 1000).toISOString() : null,
      });
    }

    return result;
  }

  // ─── Send message ───────────────────────────────────────────────────────

  async sendMessage(chatId: string, text: string, replyTo?: number): Promise<number> {
    if (!this.client || !this.isConnected()) {
      throw new Error('Telegram client is not connected.');
    }

    const peer = await this.resolvePeer(chatId);
    const result = await this.client.sendMessage(peer, {
      message: text,
      replyTo: replyTo ? replyTo : undefined,
    });

    return result.id;
  }

  // ─── Read messages ──────────────────────────────────────────────────────

  async getMessages(chatId: string, limit = 20): Promise<Array<{
    id: number;
    senderId: string;
    senderName: string;
    text: string;
    date: string;
    isOutgoing: boolean;
  }>> {
    if (!this.client || !this.isConnected()) {
      throw new Error('Telegram client is not connected.');
    }

    const peer = await this.resolvePeer(chatId);
    const messages = await this.client.getMessages(peer, { limit });

    return messages
      .filter((m) => m.message)
      .map((m) => ({
        id: m.id,
        senderId: m.senderId ? String(m.senderId) : '',
        senderName: (m as any)._sender?.firstName || (m as any)._sender?.title || '',
        text: m.message || '',
        date: m.date ? new Date(m.date * 1000).toISOString() : '',
        isOutgoing: m.out ?? false,
      }));
  }

  // ─── Message sync ──────────────────────────────────────────────────────

  /**
   * Fetch recent messages from Telegram and store them locally.
   * Called once when a chat is first added to monitoring.
   */
  async syncChatHistory(chatId: string, limit = 200): Promise<number> {
    if (!this.client || !this.isConnected()) {
      this.logger.warn(`Cannot sync chat ${chatId}: client not connected`);
      return 0;
    }

    // Skip if already synced
    const existing = await this.messagesRepository.getMessageCount(chatId);
    if (existing > 0) {
      this.logger.debug(`Chat ${chatId} already has ${existing} messages, skipping sync`);
      return existing;
    }

    try {
      const peer = await this.resolvePeer(chatId);
      const messages = await this.client.getMessages(peer, { limit });

      const toStore: CreateStoredMessageParams[] = messages
        .filter((m) => m.message)
        .map((m) => ({
          chatId,
          tgMessageId: m.id,
          senderId: m.senderId ? String(m.senderId) : '',
          senderName: (m as any)._sender?.firstName || (m as any)._sender?.title || '',
          text: m.message || '',
          isOutgoing: m.out ?? false,
          replyToId: (m.replyTo as any)?.replyToMsgId,
          timestamp: m.date ? new Date(m.date * 1000).toISOString() : new Date().toISOString(),
        }));

      const inserted = await this.messagesRepository.saveBulk(toStore);
      this.logger.log(`Synced ${inserted} messages for chat ${chatId}`);
      return inserted;
    } catch (err) {
      this.logger.error(`Failed to sync chat ${chatId}: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private async resolveCredentials(): Promise<{ apiId: number; apiHash: string }> {
    const settingsApiId = await this.settingsService.getValue(TG_CLIENT_SETTINGS.API_ID);
    const settingsApiHash = await this.settingsService.getValue(TG_CLIENT_SETTINGS.API_HASH);

    return {
      apiId: settingsApiId ? Number(settingsApiId) : this.config.apiId,
      apiHash: settingsApiHash || this.config.apiHash,
    };
  }

  private async finalizeAuth(user: any): Promise<TgClientSignInResult> {
    this.currentUser = {
      id: String(user.id),
      firstName: user.firstName || '',
      username: user.username || undefined,
    };
    this.authState = { step: 'authorized' };

    // Save session string
    const sessionString = (this.client!.session as StringSession).save();
    await this.settingsService.set(TG_CLIENT_SETTINGS.SESSION, sessionString);

    // Register message handler
    if (this.messageHandler) {
      const { NewMessage } = await import('telegram/events');
      this.client!.addEventHandler(this.messageHandler, new NewMessage({}));
    }

    this.logger.log(`Authorized as ${this.currentUser.firstName} (@${this.currentUser.username || 'N/A'})`);
    return { success: true, user: this.currentUser };
  }

  private async resolvePeer(chatId: string): Promise<Api.TypeEntityLike> {
    const numericId = BigInt(chatId);
    // GramJS can accept numeric IDs directly
    return numericId as unknown as Api.TypeEntityLike;
  }
}
