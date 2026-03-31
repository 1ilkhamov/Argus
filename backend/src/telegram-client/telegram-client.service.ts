import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl';

import { SettingsService } from '../settings/settings.service';
import type {
  TelegramClientConfig,
  TgClientAuthState,
  TgClientMessageInfo,
  TgClientSendCodeResult,
  TgClientSignInResult,
  TgClientStatus,
  TgClientUser,
  TgDialogInfo,
  TgQrTokenResult,
  TgQrCheckResult,
  CreateStoredMessageParams,
} from './telegram-client.types';
import { TG_CLIENT_SETTINGS } from './telegram-client.types';
import { TelegramClientRepository } from './telegram-client.repository';
import { TelegramClientMessagesRepository } from './telegram-client-messages.repository';

type TelegramHistoryMessage = {
  id: number;
  message?: string | null;
  senderId?: unknown;
  out?: boolean;
  date?: number;
  replyTo?: unknown;
  getSender?: () => Promise<unknown>;
};

type SwitchableTelegramClient = TelegramClient & {
  _switchDC?: (dcId: number) => Promise<void>;
};

@Injectable()
export class TelegramClientService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramClientService.name);
  private client: TelegramClient | null = null;
  private authState: TgClientAuthState = { step: 'idle' };
  private currentUser: TgClientUser | null = null;
  private readonly config: TelegramClientConfig;

  /** Listeners set by TelegramClientListener */
  private messageHandler?: (event: unknown) => void;

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

  getCurrentUser(): TgClientUser | null {
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

  setMessageHandler(handler: (event: unknown) => void): void {
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

    if (!(result instanceof Api.auth.SentCode)) {
      throw new Error('Unexpected response from Telegram while sending auth code.');
    }

    const phoneCodeHash = result.phoneCodeHash;
    const codeType = result.type.className;

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

    if (!(result instanceof Api.auth.SentCode)) {
      throw new Error('Unexpected response from Telegram while resending auth code.');
    }

    const phoneCodeHash = result.phoneCodeHash;
    const codeType = result.type?.className ?? 'unknown';

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

    if (result instanceof Api.auth.LoginTokenMigrateTo) {
      this.logger.log(`QR: migrating to DC ${result.dcId}`);
      await this.switchClientDc(result.dcId);

      const migrated = await this.client.invoke(
        new Api.auth.ExportLoginToken({
          apiId,
          apiHash,
          exceptIds: [],
        }),
      );

      if (migrated instanceof Api.auth.LoginToken) {
        this.authState = { step: 'awaiting_qr' };
        this.logger.log('QR token generated (after DC migration)');
        return this.buildQrToken(migrated);
      }

      if (migrated instanceof Api.auth.LoginTokenSuccess) {
        const user = this.extractAuthorizedUser(migrated);
        if (user) {
          await this.finalizeAuth(user);
        }
        return { qrUrl: '', expiresIn: 0 };
      }
    }

    if (result instanceof Api.auth.LoginToken) {
      this.authState = { step: 'awaiting_qr' };
      this.logger.log('QR token generated');
      return this.buildQrToken(result);
    }

    if (result instanceof Api.auth.LoginTokenSuccess) {
      const user = this.extractAuthorizedUser(result);
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

      if (result instanceof Api.auth.LoginTokenSuccess) {
        const user = this.extractAuthorizedUser(result);
        if (user) {
          const finalResult = await this.finalizeAuth(user);
          return { status: 'authorized', user: finalResult.user };
        }
      }

      if (result instanceof Api.auth.LoginTokenMigrateTo) {
        await this.switchClientDc(result.dcId);
        const imported = await this.client.invoke(
          new Api.auth.ImportLoginToken({ token: result.token }),
        );
        if (imported instanceof Api.auth.LoginTokenSuccess) {
          const user = this.extractAuthorizedUser(imported);
          if (user) {
            const finalResult = await this.finalizeAuth(user);
            return { status: 'authorized', user: finalResult.user };
          }
        }
      }

      return { status: 'waiting' };
    } catch (err) {
      const errorMessage = this.getTelegramErrorMessage(err);
      if (errorMessage === 'SESSION_PASSWORD_NEEDED') {
        this.authState = { step: 'awaiting_2fa' };
        return { status: 'requires_2fa' };
      }
      if (errorMessage === 'AUTH_TOKEN_EXPIRED') {
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

      if (!(result instanceof Api.auth.Authorization)) {
        throw new Error('Unexpected response from Telegram during sign-in.');
      }

      const user = this.extractAuthorizedUser(result);
      if (!user) {
        throw new Error('Telegram sign-in succeeded without returning a user.');
      }

      return this.finalizeAuth(user);
    } catch (err) {
      if (this.getTelegramErrorMessage(err) === 'SESSION_PASSWORD_NEEDED') {
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

    if (!(authResult instanceof Api.auth.Authorization)) {
      throw new Error('Unexpected response from Telegram during 2FA sign-in.');
    }

    const user = this.extractAuthorizedUser(authResult);
    if (!user) {
      throw new Error('Telegram 2FA succeeded without returning a user.');
    }

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
    const me = await this.client.getMe();
    if (!(me instanceof Api.User)) {
      throw new Error('Client connected but not authorized. Run auth flow.');
    }

    this.currentUser = this.toClientUser(me);
    this.authState = { step: 'authorized' };

    // Register message handler if set
    await this.registerMessageHandler();

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
        type = entity.megagroup ? 'supergroup' : 'channel';
      }

      result.push({
        chatId: String(dialog.id),
        title: dialog.title || (entity instanceof Api.User ? [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim() : ''),
        type,
        unreadCount: dialog.unreadCount,
        lastMessageDate: dialog.date ? new Date(dialog.date * 1000).toISOString() : null,
      });
    }

    return result;
  }

  // ─── Send message ───────────────────────────────────────────────────────

  async sendMessageDirect(chatId: string, text: string, replyTo?: number): Promise<number> {
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

  async sendMessage(chatId: string, text: string, replyTo?: number): Promise<number> {
    return this.sendMessageDirect(chatId, text, replyTo);
  }

  // ─── Read messages ──────────────────────────────────────────────────────

  async getMessages(chatId: string, limit = 20): Promise<TgClientMessageInfo[]> {
    if (!this.client || !this.isConnected()) {
      throw new Error('Telegram client is not connected.');
    }

    const peer = await this.resolvePeer(chatId);
    const messages = await this.client.getMessages(peer, { limit });

    const result: TgClientMessageInfo[] = [];
    for (const message of messages) {
      if (!message.message) continue;
      result.push(await this.toMessageInfo(message));
    }

    return result;
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

      const toStore: CreateStoredMessageParams[] = [];
      for (const message of messages) {
        if (!message.message) continue;
        toStore.push(await this.toStoredMessageParams(chatId, message));
      }

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

  private async finalizeAuth(user: Api.User): Promise<TgClientSignInResult> {
    this.currentUser = this.toClientUser(user);
    this.authState = { step: 'authorized' };

    // Save session string
    const sessionString = (this.client!.session as StringSession).save();
    await this.settingsService.set(TG_CLIENT_SETTINGS.SESSION, sessionString);

    // Register message handler
    await this.registerMessageHandler();

    this.logger.log(`Authorized as ${this.currentUser.firstName} (@${this.currentUser.username || 'N/A'})`);
    return { success: true, user: this.currentUser };
  }

  private async registerMessageHandler(): Promise<void> {
    if (!this.client || !this.messageHandler) return;
    const { NewMessage } = await import('telegram/events');
    this.client.addEventHandler(this.messageHandler, new NewMessage({}));
  }

  private toClientUser(user: Api.User): TgClientUser {
    return {
      id: String(user.id),
      firstName: user.firstName || '',
      username: user.username || undefined,
    };
  }

  private async switchClientDc(dcId: number): Promise<void> {
    const client = this.client as SwitchableTelegramClient | null;
    if (!client?._switchDC) {
      throw new Error('Telegram client cannot switch data centers during QR auth.');
    }
    await client._switchDC(dcId);
  }

  private buildQrToken(result: Api.auth.LoginToken): TgQrTokenResult {
    const token = Buffer.from(result.token).toString('base64url');
    const expiresIn = Number(result.expires) - Math.floor(Date.now() / 1000);
    return { qrUrl: `tg://login?token=${token}`, expiresIn };
  }

  private extractAuthorizedUser(result: Api.auth.Authorization | Api.auth.LoginTokenSuccess): Api.User | null {
    if (result instanceof Api.auth.LoginTokenSuccess) {
      const authorization = result.authorization;
      if (!(authorization instanceof Api.auth.Authorization)) {
        return null;
      }
      return authorization.user instanceof Api.User ? authorization.user : null;
    }

    return result.user instanceof Api.User ? result.user : null;
  }

  private async toMessageInfo(message: TelegramHistoryMessage): Promise<TgClientMessageInfo> {
    const senderName = await this.resolveMessageSenderName(message);
    return {
      id: message.id,
      senderId: message.senderId ? String(message.senderId) : '',
      senderName,
      text: message.message ?? '',
      date: typeof message.date === 'number' ? new Date(message.date * 1000).toISOString() : '',
      isOutgoing: message.out === true,
    };
  }

  private async toStoredMessageParams(chatId: string, message: TelegramHistoryMessage): Promise<CreateStoredMessageParams> {
    const info = await this.toMessageInfo(message);
    return {
      chatId,
      tgMessageId: info.id,
      senderId: info.senderId,
      senderName: info.senderName,
      text: info.text,
      isOutgoing: info.isOutgoing,
      replyToId: this.getReplyToMessageId(message.replyTo),
      timestamp: info.date || new Date().toISOString(),
    };
  }

  private async resolveMessageSenderName(message: TelegramHistoryMessage): Promise<string> {
    try {
      const sender = typeof message.getSender === 'function' ? await message.getSender() : null;
      return this.getSenderDisplayName(sender);
    } catch {
      return 'Unknown';
    }
  }

  private getSenderDisplayName(sender: unknown): string {
    if (sender instanceof Api.User) {
      return [sender.firstName, sender.lastName].filter(Boolean).join(' ').trim() || sender.username || 'Unknown';
    }
    if (sender instanceof Api.Chat || sender instanceof Api.Channel) {
      return sender.title || 'Unknown';
    }
    return 'Unknown';
  }

  private getReplyToMessageId(replyTo: unknown): number | undefined {
    if (!this.isRecord(replyTo)) return undefined;
    const replyToMsgId = replyTo.replyToMsgId;
    return typeof replyToMsgId === 'number' ? replyToMsgId : undefined;
  }

  private getTelegramErrorMessage(error: unknown): string | null {
    if (!this.isRecord(error)) return null;
    const errorMessage = error.errorMessage;
    return typeof errorMessage === 'string' ? errorMessage : null;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private async resolvePeer(chatId: string): Promise<Api.TypeEntityLike> {
    const numericId = BigInt(chatId);
    // GramJS can accept numeric IDs directly
    return numericId as unknown as Api.TypeEntityLike;
  }
}
