import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

import { ARGUS_CORE_CONTRACT } from '../../core-contract';
import {
  type SoulConfig,
  validateSoulConfig,
  isSoulConfigError,
} from './soul-config.types';

const DEFAULT_SOUL_PATH = path.join(__dirname, 'soul.default.yml');
const DATA_SOUL_PATH = path.resolve(process.cwd(), 'data', 'soul.yml');
const SOURCE_SOUL_PATH = path.resolve(process.cwd(), 'src', 'agent', 'identity', 'config', 'soul.default.yml');

export type SoulConfigSourceKind =
  | 'configured_path'
  | 'data_override'
  | 'bundled_default'
  | 'source_default'
  | 'core_contract_fallback';

export interface SoulConfigRuntimeState {
  source: string;
  sourceKind: SoulConfigSourceKind;
  watching: boolean;
  configuredPath?: string;
}

@Injectable()
export class SoulConfigService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SoulConfigService.name);
  private config!: SoulConfig;
  private watcher?: fs.FSWatcher;
  private readonly configPath: string;
  private loadedFrom = 'core_contract_fallback';
  private loadedSourceKind: SoulConfigSourceKind = 'core_contract_fallback';

  constructor(private readonly configService: ConfigService) {
    this.configPath = this.configService.get<string>('soul.configPath') || '';
  }

  onModuleInit(): void {
    this.config = this.loadConfig();
    this.startWatching();
  }

  onModuleDestroy(): void {
    this.stopWatching();
  }

  /** Returns the current soul config (always valid). */
  getSoulConfig(): SoulConfig {
    return this.config;
  }

  getRuntimeState(): SoulConfigRuntimeState {
    return {
      source: this.loadedFrom,
      sourceKind: this.loadedSourceKind,
      watching: Boolean(this.watcher),
      ...(this.configPath ? { configuredPath: this.configPath } : {}),
    };
  }

  // ─── Loading ────────────────────────────────────────────────────────────

  private loadConfig(): SoulConfig {
    // Priority: user-specified path → data/soul.yml → bundled default → core-contract fallback
    const candidates = [...new Set([this.configPath, DATA_SOUL_PATH, DEFAULT_SOUL_PATH, SOURCE_SOUL_PATH].filter(Boolean))];

    for (const filePath of candidates) {
      const result = this.tryLoadFile(filePath);
      if (result) {
        this.loadedFrom = filePath;
        this.loadedSourceKind = this.resolveSourceKind(filePath);
        return result;
      }
    }

    this.logger.warn('No soul config found, using core-contract fallback');
    this.loadedFrom = 'core_contract_fallback';
    this.loadedSourceKind = 'core_contract_fallback';
    return this.coreContractFallback();
  }

  private tryLoadFile(filePath: string): SoulConfig | undefined {
    try {
      if (!fs.existsSync(filePath)) return undefined;

      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = yaml.load(raw);
      const result = validateSoulConfig(parsed);

      if (isSoulConfigError(result)) {
        this.logger.warn(`Invalid soul config at ${filePath}: ${result.error}`);
        return undefined;
      }

      this.logger.log(`Soul config loaded from ${filePath}`);
      return result;
    } catch (error) {
      this.logger.warn(
        `Failed to load soul config from ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  // ─── File watching (hot-reload) ─────────────────────────────────────────

  private startWatching(): void {
    // Watch the primary config path and the data/soul.yml fallback
    const watchTargets = [
      this.configPath,
      path.resolve(process.cwd(), 'data', 'soul.yml'),
    ].filter((p) => p && fs.existsSync(p));

    if (watchTargets.length === 0) return;

    const target = watchTargets[0]!;
    try {
      let debounceTimer: ReturnType<typeof setTimeout> | undefined;

      this.watcher = fs.watch(target, (eventType) => {
        if (eventType !== 'change') return;

        // Debounce: some editors fire multiple change events
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          this.handleFileChange(target);
        }, 500);
      });

      this.logger.debug(`Watching soul config at ${target}`);
    } catch (error) {
      this.logger.debug(
        `Cannot watch soul config: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private handleFileChange(filePath: string): void {
    const result = this.tryLoadFile(filePath);
    if (result) {
      this.config = result;
      this.loadedFrom = filePath;
      this.loadedSourceKind = this.resolveSourceKind(filePath);
      this.logger.log(`Soul config hot-reloaded from ${filePath}`);
    }
  }

  private resolveSourceKind(filePath: string): SoulConfigSourceKind {
    if (this.configPath && filePath === this.configPath) {
      return 'configured_path';
    }
    if (filePath === DATA_SOUL_PATH) {
      return 'data_override';
    }
    if (filePath === DEFAULT_SOUL_PATH) {
      return 'bundled_default';
    }
    if (filePath === SOURCE_SOUL_PATH) {
      return 'source_default';
    }
    return 'configured_path';
  }

  private stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }

  // ─── Core-contract fallback ─────────────────────────────────────────────

  private coreContractFallback(): SoulConfig {
    const cc = ARGUS_CORE_CONTRACT;
    return {
      name: cc.identity.name,
      role: cc.identity.role,
      mission: cc.identity.mission,
      personality: [
        'Direct and clear. Lead with the answer, not with framing.',
        'Intellectually honest. Separate known from guessed.',
        'Pragmatic. Prefer action over theory.',
      ],
      invariants: cc.invariants,
      never: [
        'Start a response with filler affirmations like "Great question!"',
        'Apologize for previous responses',
        'Summarize what the user just said as a preamble',
      ],
      values: [
        'Accuracy over speed',
        'Usefulness over politeness',
        'Clarity over completeness',
      ],
      defaultBehavior: cc.defaultBehavior,
      interactionContract: cc.interactionContract,
      antiGoals: cc.antiGoals,
    };
  }
}
