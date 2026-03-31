import { Injectable } from '@nestjs/common';

import { TelegramOutboundAuditRepository } from './telegram-outbound-audit.repository';
import { TelegramPolicyDeniedError } from './telegram-policy-denied.error';
import { TelegramPolicyService } from './telegram-policy.service';
import type { TelegramPolicyEvaluationInput } from './telegram-runtime.types';

export interface ExecuteTelegramOutboundParams extends TelegramPolicyEvaluationInput {
  payloadPreview?: string | null;
}

@Injectable()
export class TelegramOutboundService {
  constructor(
    private readonly policyService: TelegramPolicyService,
    private readonly auditRepository: TelegramOutboundAuditRepository,
  ) {}

  evaluate(input: TelegramPolicyEvaluationInput) {
    return this.policyService.evaluateOutbound(input);
  }

  async executeSend<T>(params: ExecuteTelegramOutboundParams, perform: () => Promise<T>): Promise<T> {
    const evaluation = this.policyService.evaluateOutbound(params);

    if (evaluation.decision === 'deny') {
      await this.auditRepository.create({
        channel: params.channel,
        action: params.action,
        actor: params.actor,
        origin: params.origin,
        targetChatId: params.chatId ?? null,
        targetChatTitle: params.chatTitle ?? null,
        monitoredChatId: params.monitoredChatId ?? null,
        monitoredMode: params.monitoredMode ?? null,
        scopeKey: params.scopeKey ?? null,
        conversationId: params.conversationId ?? null,
        correlationId: params.correlationId ?? null,
        policyDecision: evaluation.decision,
        policyReasonCode: evaluation.reasonCode,
        result: 'blocked',
        payloadPreview: this.normalizePayloadPreview(params.payloadPreview),
        errorMessage: evaluation.message,
      });
      throw new TelegramPolicyDeniedError(evaluation);
    }

    const event = await this.auditRepository.create({
      channel: params.channel,
      action: params.action,
      actor: params.actor,
      origin: params.origin,
      targetChatId: params.chatId ?? null,
      targetChatTitle: params.chatTitle ?? null,
      monitoredChatId: params.monitoredChatId ?? null,
      monitoredMode: params.monitoredMode ?? null,
      scopeKey: params.scopeKey ?? null,
      conversationId: params.conversationId ?? null,
      correlationId: params.correlationId ?? null,
      policyDecision: evaluation.decision,
      policyReasonCode: evaluation.reasonCode,
      result: 'attempted',
      payloadPreview: this.normalizePayloadPreview(params.payloadPreview),
    });

    try {
      const output = await perform();
      await this.auditRepository.updateResult(event.id, 'sent');
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.auditRepository.updateResult(event.id, 'failed', message);
      throw error;
    }
  }

  private normalizePayloadPreview(value?: string | null): string | null {
    const text = String(value ?? '').trim();
    if (!text) {
      return null;
    }

    return text.length <= 300 ? text : `${text.slice(0, 299)}…`;
  }
}
