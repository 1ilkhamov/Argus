import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { SoulConfigService, type SoulConfigRuntimeState } from '../agent/identity/config/soul-config.service';
import { TelegramAuthService, type TelegramAuthRuntimeState } from '../telegram/auth/telegram.auth.service';
import { TelegramService, type TelegramStatus } from '../telegram/bot/telegram.service';
import { AppleScriptTool, type AppleScriptRuntimeState } from '../tools/builtin/system/applescript.tool';

export interface RuntimeDiagnosticWarning {
  code: string;
  severity: 'info' | 'warning';
  subject: 'soul' | 'telegram' | 'applescript' | 'storage' | 'qdrant' | 'prompt' | 'continuation';
  message: string;
  action?: string;
}

export interface BootstrapDiagnosticsStorageState {
  driver: string;
  dataFilePath: string;
  dbFilePath: string;
  memoryDbFilePath: string;
  postgresConfigured: boolean;
}

export interface BootstrapDiagnosticsTelegramState extends TelegramStatus, TelegramAuthRuntimeState {}

export interface BootstrapDiagnosticsSummary {
  timestamp: string;
  soul: SoulConfigRuntimeState;
  storage: BootstrapDiagnosticsStorageState;
  telegram: BootstrapDiagnosticsTelegramState;
  applescript: AppleScriptRuntimeState;
  warnings: RuntimeDiagnosticWarning[];
}

@Injectable()
export class BootstrapDiagnosticsService {
  constructor(
    private readonly configService: ConfigService,
    private readonly soulConfigService: SoulConfigService,
    private readonly telegramService: TelegramService,
    private readonly telegramAuthService: TelegramAuthService,
    private readonly appleScriptTool: AppleScriptTool,
  ) {}

  getSummary(): BootstrapDiagnosticsSummary {
    const soul = this.soulConfigService.getRuntimeState();
    const telegramStatus = this.telegramService.getStatus();
    const telegramAuth = this.telegramAuthService.getRuntimeState();
    const summary: BootstrapDiagnosticsSummary = {
      timestamp: new Date().toISOString(),
      soul,
      storage: {
        driver: this.configService.get<string>('storage.driver', 'sqlite'),
        dataFilePath: this.configService.get<string>('storage.dataFilePath', ''),
        dbFilePath: this.configService.get<string>('storage.dbFilePath', ''),
        memoryDbFilePath: this.configService.get<string>('storage.memoryDbFilePath', ''),
        postgresConfigured: Boolean(this.configService.get<string>('storage.postgresUrl', '')),
      },
      telegram: {
        enabled: telegramStatus.enabled,
        tokenConfigured: telegramStatus.tokenConfigured,
        tokenSource: telegramStatus.tokenSource,
        running: telegramStatus.running,
        username: telegramStatus.username,
        mode: telegramStatus.mode,
        allowlistConfigured: telegramAuth.allowlistConfigured,
        allowedUsersCount: telegramAuth.allowedUsersCount,
      },
      applescript: this.appleScriptTool.getRuntimeState(),
      warnings: [],
    };

    summary.warnings = this.buildWarnings(summary);
    return summary;
  }

  private buildWarnings(summary: BootstrapDiagnosticsSummary): RuntimeDiagnosticWarning[] {
    const warnings: RuntimeDiagnosticWarning[] = [];

    if (summary.soul.sourceKind === 'core_contract_fallback') {
      warnings.push({
        code: 'soul_core_contract_fallback',
        severity: 'warning',
        subject: 'soul',
        message: 'Soul config is running on core-contract fallback instead of a loaded YAML config.',
        action: 'Provide a bundled soul.default.yml, data/soul.yml, or set SOUL_CONFIG_PATH to a valid file.',
      });
    }

    if (summary.telegram.enabled && !summary.telegram.tokenConfigured) {
      warnings.push({
        code: 'telegram_enabled_without_token',
        severity: 'warning',
        subject: 'telegram',
        message: 'Telegram inbound runtime is enabled, but no bot token is configured.',
        action: 'Set TELEGRAM_BOT_TOKEN or configure telegram.bot_token in settings.',
      });
    }

    if (summary.telegram.enabled && !summary.telegram.allowlistConfigured) {
      warnings.push({
        code: 'telegram_empty_allowlist',
        severity: 'warning',
        subject: 'telegram',
        message: 'Telegram inbound runtime is enabled, but TELEGRAM_ALLOWED_USERS is empty.',
        action: 'Set TELEGRAM_ALLOWED_USERS or configure telegram.allowed_users in settings.',
      });
    }

    if (summary.applescript.supported && !summary.applescript.enabled) {
      warnings.push({
        code: 'applescript_disabled',
        severity: 'info',
        subject: 'applescript',
        message: 'AppleScript is supported on this host but disabled in configuration.',
        action: 'Enable TOOLS_APPLESCRIPT_ENABLED if macOS automation is expected.',
      });
    }

    return warnings;
  }
}
