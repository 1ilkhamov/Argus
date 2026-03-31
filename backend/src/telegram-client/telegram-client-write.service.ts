import { Injectable } from '@nestjs/common';

import { TelegramOutboundService } from '../telegram-runtime/telegram-outbound.service';
import type { TelegramOutboundActor, TelegramOutboundOrigin } from '../telegram-runtime/telegram-runtime.types';
import { TelegramClientRepository } from './telegram-client.repository';
import { TelegramClientService } from './telegram-client.service';

export interface SendManagedTelegramClientMessageParams {
  chatId: string;
  text: string;
  replyTo?: number;
  actor: TelegramOutboundActor;
  origin: TelegramOutboundOrigin;
  scopeKey?: string;
  conversationId?: string;
  correlationId?: string;
  chatTitle?: string | null;
}

@Injectable()
export class TelegramClientWriteService {
  constructor(
    private readonly clientService: TelegramClientService,
    private readonly repository: TelegramClientRepository,
    private readonly outboundService: TelegramOutboundService,
  ) {}

  async sendMessage(params: SendManagedTelegramClientMessageParams): Promise<number> {
    const monitoredChat = await this.repository.findByChatId(params.chatId);

    return this.outboundService.executeSend(
      {
        channel: 'telegram_client',
        action: 'send_message',
        actor: params.actor,
        origin: params.origin,
        chatId: params.chatId,
        chatTitle: params.chatTitle ?? monitoredChat?.chatTitle ?? null,
        monitoredChatId: monitoredChat?.id ?? null,
        monitoredMode: monitoredChat?.mode ?? null,
        scopeKey: params.scopeKey,
        conversationId: params.conversationId,
        correlationId: params.correlationId,
        payloadPreview: params.text,
      },
      () => this.clientService.sendMessageDirect(params.chatId, params.text, params.replyTo),
    );
  }
}
