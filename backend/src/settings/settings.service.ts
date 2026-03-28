import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

import { SettingsRepository } from './settings.repository';

/** Settings that contain sensitive data and should be encrypted at rest. */
const SENSITIVE_KEY_PATTERNS = ['api_key', 'secret', 'token', 'password'];

/** AES-256-GCM encryption parameters */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT = 'argus-settings-v1';

/**
 * Well-known settings keys and their corresponding .env / ConfigService paths.
 * When a key is not set in the DB, the service falls back to the .env value.
 */
const ENV_FALLBACK_MAP: Record<string, string> = {
  'tools.web_search.brave_api_key': 'tools.webSearch.braveApiKey',
  'tools.web_search.tavily_api_key': 'tools.webSearch.tavilyApiKey',
  'tools.web_search.jina_api_key': 'tools.webSearch.jinaApiKey',
  'tools.web_search.searxng_url': 'tools.webSearch.searxngUrl',
  'tools.web_search.provider': 'tools.webSearch.provider',
  'telegram.bot_token': 'telegram.botToken',
  'telegram.allowed_users': 'telegram.allowedUsers',
  'tools.notify.telegram_chat_id': 'tools.notify.telegramChatId',
  'tools.email.provider': 'tools.email.provider',
  'tools.email.email': 'tools.email.email',
  'tools.email.password': 'tools.email.password',
  'tools.email.imap_host': 'tools.email.imapHost',
  'tools.email.imap_port': 'tools.email.imapPort',
  'tools.email.smtp_host': 'tools.email.smtpHost',
  'tools.email.smtp_port': 'tools.email.smtpPort',
  'telegram_client.api_id': 'telegramClient.apiId',
  'telegram_client.api_hash': 'telegramClient.apiHash',
};

export interface SettingDto {
  key: string;
  /** Value — for sensitive keys the stored value is encrypted; API returns masked version */
  value: string;
  sensitive: boolean;
  updatedAt: string | null;
}

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);
  private encryptionKey!: Buffer;

  constructor(
    private readonly repository: SettingsRepository,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    const secret = this.configService.get<string>('settings.encryptionSecret', '');
    const passphrase = secret || 'argus-default-encryption-key-change-me';
    this.encryptionKey = scryptSync(passphrase, SALT, 32);
    if (!secret) {
      this.logger.warn(
        'No SETTINGS_ENCRYPTION_SECRET configured — using default key. Set SETTINGS_ENCRYPTION_SECRET in .env for production.',
      );
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Get a setting value. Checks DB first, then falls back to .env config.
   * Returns the decrypted value for encrypted settings.
   */
  async getValue(key: string): Promise<string> {
    const entry = await this.repository.get(key);
    if (entry) {
      return entry.encrypted ? this.decrypt(entry.value) : entry.value;
    }

    // Fallback to .env / ConfigService
    const envPath = ENV_FALLBACK_MAP[key];
    if (envPath) {
      return this.configService.get<string>(envPath, '');
    }

    return '';
  }

  /**
   * Get a setting as a DTO (for API responses).
   * Sensitive values are masked.
   */
  async getDto(key: string): Promise<SettingDto> {
    const sensitive = this.isSensitive(key);
    const entry = await this.repository.get(key);

    if (entry) {
      const rawValue = entry.encrypted ? this.decrypt(entry.value) : entry.value;
      return {
        key,
        value: sensitive ? this.mask(rawValue) : rawValue,
        sensitive,
        updatedAt: entry.updatedAt,
      };
    }

    // Fallback
    const envPath = ENV_FALLBACK_MAP[key];
    const envValue = envPath ? this.configService.get<string>(envPath, '') : '';

    return {
      key,
      value: sensitive ? this.mask(envValue) : envValue,
      sensitive,
      updatedAt: null,
    };
  }

  /**
   * Get all known settings as DTOs (merged: DB + env fallbacks).
   */
  async getAllDtos(): Promise<SettingDto[]> {
    const allKeys = Object.keys(ENV_FALLBACK_MAP);
    const result: SettingDto[] = [];

    for (const key of allKeys) {
      result.push(await this.getDto(key));
    }

    return result;
  }

  /**
   * Set a setting value. Sensitive keys are encrypted before storage.
   */
  async set(key: string, value: string): Promise<SettingDto> {
    const sensitive = this.isSensitive(key);
    const storedValue = sensitive ? this.encrypt(value) : value;
    await this.repository.set(key, storedValue, sensitive);

    this.logger.log(`Setting updated: ${key}`);

    return {
      key,
      value: sensitive ? this.mask(value) : value,
      sensitive,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Delete a setting (reverts to .env fallback).
   */
  async delete(key: string): Promise<boolean> {
    const deleted = await this.repository.delete(key);
    if (deleted) {
      this.logger.log(`Setting deleted: ${key} (reverted to .env fallback)`);
    }
    return deleted;
  }

  // ─── Encryption ──────────────────────────────────────────────────────────

  private encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Format: base64(iv + authTag + ciphertext)
    return Buffer.concat([iv, authTag, encrypted]).toString('base64');
  }

  private decrypt(encoded: string): string {
    try {
      const data = Buffer.from(encoded, 'base64');
      const iv = data.subarray(0, IV_LENGTH);
      const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
      const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
      const decipher = createDecipheriv(ALGORITHM, this.encryptionKey, iv);
      decipher.setAuthTag(authTag);
      return decipher.update(ciphertext) + decipher.final('utf8');
    } catch (error) {
      this.logger.error(`Failed to decrypt setting: ${error instanceof Error ? error.message : error}`);
      return '';
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private isSensitive(key: string): boolean {
    return SENSITIVE_KEY_PATTERNS.some((p) => key.includes(p));
  }

  private mask(value: string): string {
    if (!value || value.length <= 8) return value ? '••••••••' : '';
    return value.slice(0, 4) + '••••' + value.slice(-4);
  }
}
