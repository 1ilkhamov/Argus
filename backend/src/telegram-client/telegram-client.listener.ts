import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Api } from 'telegram/tl';

import { ChatService } from '../chat/chat.service';
import { TelegramClientService } from './telegram-client.service';
import { TelegramClientRepository } from './telegram-client.repository';
import { TelegramClientMessagesRepository } from './telegram-client-messages.repository';
import { TelegramClientChatProfilerService } from './telegram-client-chat-profiler.service';
import type { TgMonitoredChat, TgStoredMessage, TgChatProfile } from './telegram-client.types';

/** Ignore messages older than this on reconnect */
const MAX_MESSAGE_AGE_S = 60;

/** Scope key prefix for telegram-client conversations */
const SCOPE_PREFIX = 'tg-client';

/** How many recent messages to include as conversation context */
const CONTEXT_MESSAGES_LIMIT = 40;

/** Item queued for sequential processing */
interface QueuedMessage {
  chatId: string;
  monitoredChat: TgMonitoredChat;
  text: string;
  senderName: string;
  messageId: number;
}

interface TelegramListenerMessage {
  id: number;
  message?: string | null;
  date?: number;
  senderId?: unknown;
  peerId?: unknown;
  replyTo?: unknown;
  getSender?: () => Promise<unknown>;
}

@Injectable()
export class TelegramClientListener implements OnModuleInit {
  private readonly logger = new Logger(TelegramClientListener.name);

  /** chatId → last reply timestamp (ms) for cooldown enforcement */
  private readonly lastReplyAt = new Map<string, number>();

  /** Per-chat sequential message queue */
  private readonly chatQueues = new Map<string, QueuedMessage[]>();
  /** chatId → true if queue is currently being drained */
  private readonly chatQueueActive = new Map<string, boolean>();

  constructor(
    private readonly clientService: TelegramClientService,
    private readonly chatService: ChatService,
    private readonly repository: TelegramClientRepository,
    private readonly messagesRepository: TelegramClientMessagesRepository,
    private readonly chatProfiler: TelegramClientChatProfilerService,
  ) {}

  onModuleInit(): void {
    // Register ourselves as the message handler before the client connects
    this.clientService.setMessageHandler((event: unknown) => {
      this.handleNewMessage(event).catch((err) => {
        this.logger.error(`Message handler error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    this.logger.log('Telegram client listener registered');
  }

  // ─── Message handling ───────────────────────────────────────────────────

  private async handleNewMessage(event: unknown): Promise<void> {
    const message = this.extractEventMessage(event);
    if (!message || !message.message) return;

    // Ignore old messages (e.g. on reconnect)
    const messageAge = Math.floor(Date.now() / 1000) - (message.date || 0);
    if (messageAge > MAX_MESSAGE_AGE_S) return;

    const myId = this.clientService.getMyUserId();
    const senderId = message.senderId ? String(message.senderId) : '';
    const isOwnMessage = !!(myId && senderId === myId);

    // Resolve chat ID
    const chatId = this.resolveChatId(message.peerId);
    if (!chatId) return;

    // Check if this chat is monitored
    const monitoredChat = await this.repository.findByChatId(chatId);
    if (!monitoredChat || monitoredChat.mode === 'disabled') return;

    const text = message.message.trim();
    if (!text) return;

    const senderName = isOwnMessage
      ? (this.clientService.getCurrentUser()?.firstName || 'Owner')
      : await this.resolveSenderName(message);

    // Persist message to local store (all messages including owner's, for context)
    this.messagesRepository.save({
      chatId,
      tgMessageId: message.id,
      senderId,
      senderName,
      text,
      isOutgoing: isOwnMessage,
      replyToId: this.getReplyToMessageId(message.replyTo),
      timestamp: message.date ? new Date(message.date * 1000).toISOString() : new Date().toISOString(),
    }).catch((err) => {
      this.logger.warn(`Failed to persist message: ${err instanceof Error ? err.message : String(err)}`);
    });

    // Don't process own messages for reply (avoid infinite loop)
    if (isOwnMessage) return;

    this.logger.debug(
      `[${monitoredChat.chatTitle}] ${senderName}: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`,
    );

    // read_only mode: just log, don't reply
    if (monitoredChat.mode === 'read_only') return;

    // Smart reply decision based on chat type
    if (!(await this.shouldReply(monitoredChat, chatId, text, message))) {
      this.logger.debug(`shouldReply=false for chat ${chatId} (${monitoredChat.chatType}), skipping`);
      return;
    }

    // Enqueue for sequential processing (ensures all mentions get a reply)
    this.enqueue({ chatId, monitoredChat, text, senderName, messageId: message.id });
  }

  // ─── Context assembly & reply ──────────────────────────────────────────

  private async processAndReply(
    chatId: string,
    monitoredChat: TgMonitoredChat,
    text: string,
    senderName: string,
    messageId: number,
  ): Promise<void> {
    try {
      const scopeKey = `${SCOPE_PREFIX}:${chatId}`;

      // 1. Get owner name for profile
      const ownerUser = this.clientService.getCurrentUser();
      const ownerName = ownerUser?.firstName || 'Owner';

      // 2. Load/build chat style profile (cached, rebuilt every ~50 msgs)
      const profile = await this.chatProfiler.getOrBuildProfile(
        chatId, monitoredChat.chatType, ownerName,
      ).catch((err) => {
        this.logger.warn(`Profile load failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });

      // 3. Load recent conversation from local DB
      const recentMessages = await this.messagesRepository.getRecent(chatId, CONTEXT_MESSAGES_LIMIT);

      // 4. Build rich system instruction
      const extraSystemInstruction = this.buildTelegramInstruction(
        monitoredChat, ownerName, senderName, profile, recentMessages,
      );

      // 5. User content is just the new message — context is in the system instruction
      const userContent = `[From: ${senderName}]\n${text}`;

      // Each message = fresh conversation; context is in the system instruction from DB
      // Pass source chat info via toolMeta so notify tool can create "Reply" buttons
      // Note: telegram_client write actions are blocked from tg-client scope inside the tool itself
      const { assistantMessage } = await this.chatService.sendMessage(
        undefined,
        userContent,
        {
          scopeKey,
          extraSystemInstruction,
          // telegram_client tool self-blocks write actions from tg-client scope
          toolMeta: {
            sourceChatId: chatId,
            sourceChatTitle: monitoredChat.chatTitle,
          },
        },
      );

      // 6. Sanitize & send reply (agent can respond with [SKIP] to decline)
      const rawReply = assistantMessage.content.trim();
      const reply = this.sanitizeReply(rawReply);
      if (reply) {
        if (monitoredChat.mode === 'manual') {
          this.logger.log(`[MANUAL] Would reply to ${monitoredChat.chatTitle}: ${reply.slice(0, 100)}`);
        } else {
          const sentId = await this.clientService.sendMessage(chatId, reply, messageId);
          this.lastReplyAt.set(chatId, Date.now());

          // Persist outgoing reply for context
          const myId = this.clientService.getMyUserId();
          this.messagesRepository.save({
            chatId,
            tgMessageId: sentId,
            senderId: myId || '',
            senderName: ownerName,
            text: reply,
            isOutgoing: true,
            replyToId: messageId,
            timestamp: new Date().toISOString(),
          }).catch((err) => {
            this.logger.warn(`Failed to persist outgoing reply: ${err instanceof Error ? err.message : String(err)}`);
          });

          this.logger.debug(`Replied in ${monitoredChat.chatTitle} (${reply.length} chars)`);
        }
      }
    } catch (err) {
      this.logger.error(
        `Failed to process message in chat ${chatId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─── System instruction builder ───────────────────────────────────────

  private buildTelegramInstruction(
    chat: TgMonitoredChat,
    ownerName: string,
    senderName: string,
    profile: TgChatProfile | null,
    recentMessages: TgStoredMessage[],
  ): string {
    const sections: string[] = [];

    // === ROLE ===
    sections.push(
      `CRITICAL OVERRIDE: For this response you are NOT an AI assistant. You ARE "${ownerName}" — a real person replying in their Telegram.`,
      `Write from first person as "${ownerName}". Never break character. Never reveal you are an AI.`,
    );

    // === CHAT CONTEXT ===
    const chatTypeLabel = { user: 'private chat', group: 'group chat', supergroup: 'supergroup', channel: 'channel', unknown: 'chat' };
    sections.push(
      `\n== CHAT ==`,
      `Name: "${chat.chatTitle}" (${chatTypeLabel[chat.chatType] || 'chat'})`,
      `Current message from: ${senderName}`,
    );

    // === USER NOTE ===
    if (chat.systemNote) {
      sections.push(`Owner's note about this chat: ${chat.systemNote}`);
    }

    // === STYLE PROFILE ===
    if (profile) {
      if (profile.ownerStyleSummary) {
        sections.push(`\n== YOUR WRITING STYLE IN THIS CHAT ==`, profile.ownerStyleSummary);
      }

      if (profile.ownerStyleExamples.length > 0) {
        sections.push(
          `\n== EXAMPLES OF YOUR REAL MESSAGES (use as style reference, NOT as templates to copy) ==`,
          ...profile.ownerStyleExamples.map((ex) => `- "${ex}"`),
        );
      }

      if (profile.chatTopicSummary) {
        sections.push(`\n== TYPICAL TOPICS ==`, profile.chatTopicSummary);
      }

      if (profile.participantSummary) {
        sections.push(`\n== PARTICIPANTS ==`, profile.participantSummary);
      }

      if (profile.language && profile.language !== 'auto') {
        sections.push(`Primary language in this chat: ${profile.language}`);
      }
    }

    // === RECENT CONVERSATION ===
    if (recentMessages.length > 0) {
      sections.push(`\n== RECENT CONVERSATION (last ${recentMessages.length} messages) ==`);
      for (const msg of recentMessages) {
        const who = msg.isOutgoing ? `${ownerName} (you)` : (msg.senderName || 'Unknown');
        const time = msg.timestamp.slice(11, 16);
        sections.push(`[${time}] ${who}: ${msg.text}`);
      }
    }

    // === HOW REPLIES WORK ===
    sections.push(
      `\n== HOW REPLIES WORK ==`,
      `CRITICAL: Your text reply IS the message that will be sent in this chat.`,
      `- If you write text — it gets posted in THIS conversation as a reply.`,
      `- NEVER use the "telegram_client" tool to send messages — your reply text IS the message.`,
      `- The "notify" tool sends a SEPARATE side-notification to the owner via bot. It does NOT replace your reply.`,
    );

    // === TOOLS — MANDATORY SEARCH-FIRST POLICY ===
    sections.push(
      `\n== TOOLS — MANDATORY SEARCH-FIRST POLICY ==`,
      `You have access to powerful tools. You MUST use them before giving up on any question.`,
      ``,
      `STEP 1 — ALWAYS SEARCH FIRST (mandatory for any factual question):`,
      `  a) "knowledge_search" — search your memory/knowledge base for contacts, facts, notes`,
      `  b) "memory_manage" with action "search" — search stored memories`,
      `  c) "telegram_client" action "list_dialogs" — list all Telegram contacts/chats`,
      `  d) "telegram_client" action "read_messages" with a chat_id — read conversation history from a specific chat (use to find phone numbers shared there, agreements, etc.)`,
      `  e) "web_search" — search the web for public info (addresses, prices, links, hours, etc.)`,
      `  f) "web_fetch" — fetch a specific URL if you know it`,
      `  g) "calculator", "datetime" — for calculations and time queries`,
      ``,
      `STEP 2 — If tools FOUND the answer → reply with it directly. Done.`,
      ``,
      `STEP 3 — ONLY if ALL tools returned nothing relevant → THEN use "notify" to ask the owner.`,
      ``,
      `NEVER skip Step 1. NEVER go straight to notify without searching first.`,
      `NEVER say "у меня нет" or "не под рукой" without actually searching.`,
      `If someone asks for a phone number — search memory first. A link — search web first. Always.`,
    );

    // === WHEN TO USE NOTIFY (last resort) ===
    sections.push(
      `\n== WHEN TO USE NOTIFY (last resort) ==`,
      `The "notify" tool sends a private message to the owner via bot.`,
      `Use it ONLY after you've searched with tools and found nothing:`,
      ``,
      `1. PERSONAL INFO NOT IN MEMORY (private phone number, personal address, etc.):`,
      `   - You searched knowledge_search and memory_manage → nothing found`,
      `   - Call "notify" with: who is asking, what they need`,
      `   - Reply with a natural stall: "щас гляну", "секунду", "сейчас скину"`,
      ``,
      `2. SERIOUS COMMITMENTS (meetings, money, deadlines, promises):`,
      `   - Call "notify" with: who, what, when, where`,
      `   - Stall naturally: "дай гляну расписание", "щас посмотрю"`,
      `   - Do NOT confirm until the owner responds`,
      ``,
      `IMPORTANT: You MUST call "notify" BEFORE writing your stall reply. Both happen in the same response.`,
    );

    // === RULES ===
    sections.push(
      `\n== RULES ==`,
      `- ALWAYS write your reply as plain text — this text will be sent in the chat`,
      `- Your reply MUST be contextually relevant — actually answer the question or respond to what was said`,
      `- BE HELPFUL AND PROACTIVE: if you can look something up or provide useful info, DO IT`,
      `- Match the general tone, language, and approximate message length from the examples — but do NOT copy exact words or phrases from them`,
      `- Write naturally like in a messenger — no markdown, no formatting, no lists, no headers`,
      `- Do NOT reveal you are an AI under any circumstances`,
      `- Match the language of the conversation (if they write in Russian, reply in Russian)`,
      `- Use the RECENT CONVERSATION above to understand the ongoing context and give a coherent reply`,
      `- If you don't have specific information (phone number, address, etc.) — say so naturally: "не помню", "надо глянуть", "сейчас не под рукой". NEVER make up numbers, contacts, or facts.`,
      `- If the message doesn't require a reply or you're unsure what to say, respond with exactly: [SKIP]`,
    );

    return sections.join('\n');
  }

  // ─── Reply sanitization ────────────────────────────────────────────────

  /**
   * Clean up AI artifacts from the reply to make it look like a natural human message.
   * Returns empty string if the reply should be skipped.
   */
  private sanitizeReply(raw: string): string {
    if (!raw) return '';

    // Agent declined to reply
    if (raw.includes('[SKIP]')) return '';

    let text = raw;

    // Remove markdown bold/italic (only paired markers with word boundaries)
    text = text.replace(/\*\*(.+?)\*\*/g, '$1');
    text = text.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '$1');
    text = text.replace(/__(.+?)__/g, '$1');

    // Remove markdown headers
    text = text.replace(/^#{1,6}\s+/gm, '');

    // Convert markdown bullet lists to plain text
    text = text.replace(/^[-*•]\s+/gm, '');

    // Convert numbered lists to plain text
    text = text.replace(/^\d+\.\s+/gm, '');

    // Remove code fences
    text = text.replace(/```[\s\S]*?```/g, (match) => {
      return match.replace(/```\w*\n?/g, '').replace(/```/g, '').trim();
    });
    text = text.replace(/`(.+?)`/g, '$1');

    // Remove horizontal rules
    text = text.replace(/^---+$/gm, '');

    // Collapse excessive newlines (max 2 consecutive)
    text = text.replace(/\n{3,}/g, '\n\n');

    // Trim
    text = text.trim();

    // If the cleaned text is empty or just whitespace, skip
    if (!text) return '';

    return text;
  }

  // ─── Reply decision ────────────────────────────────────────────────────

  /**
   * Decide whether to reply based on chat type and message context.
   * - Private (user): always reply
   * - Group/supergroup: only if owner is mentioned, directly addressed, or it's a reply to owner's message
   * - Channel: never reply
   */
  private async shouldReply(chat: TgMonitoredChat, chatId: string, text: string, message: TelegramListenerMessage): Promise<boolean> {
    const chatType = chat.chatType;

    // Channels: never auto-reply
    if (chatType === 'channel') return false;

    // Private chats: always reply
    if (chatType === 'user') return true;

    // Groups/supergroups: reply only when relevant
    if (chatType === 'group' || chatType === 'supergroup') {
      // Check if the message is a reply to one of owner's messages
      const replyToMsgId = this.getReplyToMessageId(message.replyTo);
      if (replyToMsgId) {
        const recent = await this.messagesRepository.getRecent(chatId, 200);
        const repliedTo = recent.find((m) => m.tgMessageId === replyToMsgId);
        // Only respond if the replied-to message is confirmed ours
        // If not found in DB, default to false (safer for groups)
        return repliedTo?.isOutgoing === true;
      }

      // Check if owner's username is mentioned in the text
      const ownerUser = this.clientService.getCurrentUser();
      if (ownerUser?.username) {
        const escaped = this.escapeRegExp(ownerUser.username);
        if (new RegExp(`@${escaped}\\b`, 'i').test(text)) return true;
      }

      // Check if the owner's first name is mentioned at the start (direct address)
      if (ownerUser?.firstName) {
        const escaped = this.escapeRegExp(ownerUser.firstName);
        if (new RegExp(`^${escaped}[,:\\s!]`, 'i').test(text)) return true;
      }

      // No clear signal to reply in group
      return false;
    }

    // Unknown chat type: reply (safe default)
    return true;
  }

  private escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ─── Per-chat message queue ──────────────────────────────────────────

  private enqueue(item: QueuedMessage): void {
    const queue = this.chatQueues.get(item.chatId) ?? [];
    queue.push(item);
    this.chatQueues.set(item.chatId, queue);
    this.logger.debug(`Enqueued message in ${item.monitoredChat.chatTitle} (queue size: ${queue.length})`);
    void this.drainQueue(item.chatId);
  }

  private async drainQueue(chatId: string): Promise<void> {
    if (this.chatQueueActive.get(chatId)) return;
    this.chatQueueActive.set(chatId, true);

    try {
      for (;;) {
        const queue = this.chatQueues.get(chatId);
        if (!queue || queue.length === 0) break;

        const item = queue.shift()!;

        // Wait for cooldown if needed
        const cooldownMs = (item.monitoredChat.cooldownSeconds || 5) * 1000;
        const lastReply = this.lastReplyAt.get(chatId) ?? 0;
        const elapsed = Date.now() - lastReply;
        if (elapsed < cooldownMs) {
          const waitMs = cooldownMs - elapsed;
          this.logger.debug(`Cooldown wait ${waitMs}ms for chat ${chatId}`);
          await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        }

        await this.processAndReply(
          item.chatId, item.monitoredChat, item.text, item.senderName, item.messageId,
        );
      }
    } finally {
      this.chatQueueActive.set(chatId, false);
      // Check if new items arrived while we were finishing
      const queue = this.chatQueues.get(chatId);
      if (queue && queue.length > 0) {
        void this.drainQueue(chatId);
      }
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private resolveChatId(peerId: unknown): string | null {
    if (peerId instanceof Api.PeerUser) return String(peerId.userId);
    if (peerId instanceof Api.PeerChat) return `-${peerId.chatId}`;
    if (peerId instanceof Api.PeerChannel) return `-100${peerId.channelId}`;
    return null;
  }

  private async resolveSenderName(message: TelegramListenerMessage): Promise<string> {
    try {
      const sender = typeof message.getSender === 'function' ? await message.getSender() : null;
      if (!sender) return 'Unknown';
      if (sender instanceof Api.User) {
        return [sender.firstName, sender.lastName].filter(Boolean).join(' ') || sender.username || 'Unknown';
      }
      if (sender instanceof Api.Chat || sender instanceof Api.Channel) {
        return sender.title || 'Unknown';
      }
      return 'Unknown';
    } catch {
      return 'Unknown';
    }
  }

  private extractEventMessage(event: unknown): TelegramListenerMessage | null {
    if (!this.isRecord(event)) return null;
    const candidate = event.message;
    if (!this.isRecord(candidate)) return null;
    const id = candidate.id;
    if (typeof id !== 'number') return null;

    const message = candidate.message;
    const date = candidate.date;
    const getSender = candidate.getSender;

    return {
      id,
      message: typeof message === 'string' || message === null ? message : undefined,
      date: typeof date === 'number' ? date : undefined,
      senderId: candidate.senderId,
      peerId: candidate.peerId,
      replyTo: candidate.replyTo,
      getSender: typeof getSender === 'function'
        ? () => Promise.resolve(Reflect.apply(getSender, candidate, []))
        : undefined,
    };
  }

  private getReplyToMessageId(replyTo: unknown): number | undefined {
    if (!this.isRecord(replyTo)) return undefined;
    const replyToMsgId = replyTo.replyToMsgId;
    return typeof replyToMsgId === 'number' ? replyToMsgId : undefined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
