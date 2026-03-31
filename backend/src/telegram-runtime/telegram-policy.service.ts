import { Injectable } from '@nestjs/common';

import type { TelegramOutboundActor, TelegramPolicyEvaluation, TelegramPolicyEvaluationInput } from './telegram-runtime.types';

@Injectable()
export class TelegramPolicyService {
  evaluateOutbound(input: TelegramPolicyEvaluationInput): TelegramPolicyEvaluation {
    if (input.channel === 'telegram_bot') {
      return {
        decision: 'allow',
        reasonCode: 'ALLOW_BOT_CHANNEL',
        message: 'Telegram bot outbound delivery is allowed by the runtime policy.',
      };
    }

    if (input.monitoredMode === 'disabled') {
      return {
        decision: 'deny',
        reasonCode: 'DENY_DISABLED_MODE',
        message: 'Outbound send is blocked because the chat is disabled.',
      };
    }

    if (input.monitoredMode === 'read_only') {
      return {
        decision: 'deny',
        reasonCode: 'DENY_READ_ONLY_MODE',
        message: 'Outbound send is blocked because the chat is in read_only mode.',
      };
    }

    if (input.monitoredMode === 'manual') {
      if (this.isHumanControlled(input.actor)) {
        return {
          decision: 'allow',
          reasonCode: 'ALLOW_MANUAL_HUMAN_CONTROL',
          message: 'Outbound send is allowed because the chat is in manual mode and the action is human-controlled.',
        };
      }

      return {
        decision: 'deny',
        reasonCode: 'DENY_MANUAL_MODE_AUTOMATION',
        message: 'Outbound send is blocked because the chat is in manual mode and the action is automated.',
      };
    }

    if (input.monitoredMode === 'auto') {
      return {
        decision: 'allow',
        reasonCode: 'ALLOW_AUTO_MODE',
        message: 'Outbound send is allowed because the chat is in auto mode.',
      };
    }

    if (this.isHumanControlled(input.actor)) {
      return {
        decision: 'allow',
        reasonCode: 'ALLOW_UNMONITORED_HUMAN_CONTROL',
        message: 'Outbound send is allowed because the chat is not policy-managed and the action is human-controlled.',
      };
    }

    return {
      decision: 'deny',
      reasonCode: 'DENY_UNMONITORED_AUTOMATION',
      message: 'Outbound send is blocked because the chat is not policy-managed and the action is automated.',
    };
  }

  private isHumanControlled(actor: TelegramOutboundActor): boolean {
    return actor === 'human' || actor === 'notify_reply';
  }
}
