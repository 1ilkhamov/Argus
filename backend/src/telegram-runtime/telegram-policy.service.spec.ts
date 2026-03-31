import { TelegramPolicyService } from './telegram-policy.service';

describe('TelegramPolicyService', () => {
  let service: TelegramPolicyService;

  beforeEach(() => {
    service = new TelegramPolicyService();
  });

  it('allows telegram bot outbound actions', () => {
    const result = service.evaluateOutbound({
      channel: 'telegram_bot',
      action: 'notify',
      actor: 'system',
      origin: 'system',
    });

    expect(result).toEqual({
      decision: 'allow',
      reasonCode: 'ALLOW_BOT_CHANNEL',
      message: 'Telegram bot outbound delivery is allowed by the runtime policy.',
    });
  });

  it('denies automated sends in manual mode', () => {
    const result = service.evaluateOutbound({
      channel: 'telegram_client',
      action: 'send_message',
      actor: 'agent',
      origin: 'telegram_client_listener',
      monitoredMode: 'manual',
    });

    expect(result.decision).toBe('deny');
    expect(result.reasonCode).toBe('DENY_MANUAL_MODE_AUTOMATION');
  });

  it('allows notify replies in manual mode', () => {
    const result = service.evaluateOutbound({
      channel: 'telegram_client',
      action: 'send_message',
      actor: 'notify_reply',
      origin: 'telegram_update_handler',
      monitoredMode: 'manual',
    });

    expect(result.decision).toBe('allow');
    expect(result.reasonCode).toBe('ALLOW_MANUAL_HUMAN_CONTROL');
  });

  it('denies automated sends in unmanaged chats', () => {
    const result = service.evaluateOutbound({
      channel: 'telegram_client',
      action: 'send_message',
      actor: 'cron',
      origin: 'cron_executor',
    });

    expect(result.decision).toBe('deny');
    expect(result.reasonCode).toBe('DENY_UNMONITORED_AUTOMATION');
  });

  it('allows human-controlled sends in unmanaged chats', () => {
    const result = service.evaluateOutbound({
      channel: 'telegram_client',
      action: 'send_message',
      actor: 'human',
      origin: 'telegram_client_tool',
    });

    expect(result.decision).toBe('allow');
    expect(result.reasonCode).toBe('ALLOW_UNMONITORED_HUMAN_CONTROL');
  });

  it('denies all sends in read_only mode', () => {
    const result = service.evaluateOutbound({
      channel: 'telegram_client',
      action: 'send_message',
      actor: 'human',
      origin: 'telegram_client_tool',
      monitoredMode: 'read_only',
    });

    expect(result.decision).toBe('deny');
    expect(result.reasonCode).toBe('DENY_READ_ONLY_MODE');
  });
});
