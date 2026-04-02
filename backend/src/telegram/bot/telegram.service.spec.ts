import { TelegramService } from './telegram.service';

type TelegramConfigOverrides = Partial<{
  enabled: boolean;
  botToken: string;
  webhookUrl: string;
  webhookSecret: string;
  allowedUsers: number[];
  progressiveEdit: boolean;
  editIntervalMs: number;
}>;

function createService(overrides: {
  config?: TelegramConfigOverrides;
  settings?: Partial<Record<'telegram.bot_token' | 'telegram.allowed_users', string | undefined>>;
} = {}) {
  const config = {
    enabled: true,
    botToken: 'env-token',
    allowedUsers: [],
    webhookUrl: '',
    webhookSecret: '',
    progressiveEdit: false,
    editIntervalMs: 1500,
    ...overrides.config,
  };

  const configService = {
    get: jest.fn().mockReturnValue(config),
  } as any;

  const settings = overrides.settings ?? {};
  const settingsService = {
    getValue: jest.fn(async (key: 'telegram.bot_token' | 'telegram.allowed_users') => settings[key]),
  } as any;

  const updateHandler = {
    reloadAllowedUsers: jest.fn(),
    registerHandlers: jest.fn(),
  } as any;

  const service = new TelegramService(configService, settingsService, updateHandler);
  return { service, settingsService, updateHandler };
}

describe('TelegramService', () => {
  it('does not start when TELEGRAM_ENABLED is false', async () => {
    const { service, settingsService } = createService({
      config: { enabled: false, botToken: 'env-token' },
      settings: { 'telegram.bot_token': 'db-token' },
    });
    const startBotSpy = jest.spyOn(service as any, 'startBot').mockImplementation(async () => undefined);

    await service.onModuleInit();

    expect(settingsService.getValue).not.toHaveBeenCalled();
    expect(startBotSpy).not.toHaveBeenCalled();
    expect(service.getStatus()).toEqual({
      enabled: false,
      tokenConfigured: false,
      tokenSource: 'none',
      running: false,
      username: null,
      mode: null,
    });
  });

  it('prefers settings token and reloads allowlist on startup', async () => {
    const { service, settingsService, updateHandler } = createService({
      settings: {
        'telegram.bot_token': 'db-token',
        'telegram.allowed_users': '101,202,not-a-number',
      },
    });
    const startBotSpy = jest.spyOn(service as any, 'startBot').mockImplementation(async () => undefined);

    await service.onModuleInit();

    expect(settingsService.getValue).toHaveBeenNthCalledWith(1, 'telegram.bot_token');
    expect(settingsService.getValue).toHaveBeenNthCalledWith(2, 'telegram.allowed_users');
    expect(updateHandler.reloadAllowedUsers).toHaveBeenCalledWith([101, 202]);
    expect(startBotSpy).toHaveBeenCalledWith('db-token');
    expect(service.getStatus()).toEqual({
      enabled: true,
      tokenConfigured: true,
      tokenSource: 'settings',
      running: false,
      username: null,
      mode: null,
    });
  });

  it('restart keeps the bot disabled when TELEGRAM_ENABLED is false', async () => {
    const { service, settingsService } = createService({
      config: { enabled: false, botToken: 'env-token' },
      settings: { 'telegram.bot_token': 'db-token' },
    });
    const stopBotSpy = jest.spyOn(service as any, 'stopBot').mockImplementation(async () => undefined);
    const startBotSpy = jest.spyOn(service as any, 'startBot').mockImplementation(async () => undefined);

    await expect(service.restart()).resolves.toEqual({
      enabled: false,
      tokenConfigured: false,
      tokenSource: 'none',
      running: false,
      username: null,
      mode: null,
    });

    expect(stopBotSpy).toHaveBeenCalledTimes(1);
    expect(settingsService.getValue).not.toHaveBeenCalled();
    expect(startBotSpy).not.toHaveBeenCalled();
  });
});
