import type { TelegramPolicyEvaluation } from './telegram-runtime.types';

export class TelegramPolicyDeniedError extends Error {
  readonly evaluation: TelegramPolicyEvaluation;

  constructor(evaluation: TelegramPolicyEvaluation) {
    super(`Telegram outbound blocked: ${evaluation.reasonCode} — ${evaluation.message}`);
    this.name = 'TelegramPolicyDeniedError';
    this.evaluation = evaluation;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
