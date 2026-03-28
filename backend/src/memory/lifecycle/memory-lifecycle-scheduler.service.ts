import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { IdentityReflectionService } from '../../agent/identity/reflection/identity-reflection.service';
import { MemoryLifecycleV2Service } from './memory-lifecycle-v2.service';

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MIN_INTERVAL_MS = 60 * 1000;               // 1 minute (floor)

@Injectable()
export class MemoryLifecycleSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemoryLifecycleSchedulerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private readonly intervalMs: number;

  constructor(
    private readonly lifecycleService: MemoryLifecycleV2Service,
    private readonly identityReflectionService: IdentityReflectionService,
    configService: ConfigService,
  ) {
    const configured = configService.get<number>('memory.lifecycleIntervalMs', DEFAULT_INTERVAL_MS);
    this.intervalMs = Math.max(configured, MIN_INTERVAL_MS);
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.runCycle();
    }, this.intervalMs);

    const hours = (this.intervalMs / 3_600_000).toFixed(1);
    this.logger.log(`Memory lifecycle scheduler started — interval ${hours}h`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.logger.log('Memory lifecycle scheduler stopped');
    }
  }

  private runCycle(): void {
    this.lifecycleService
      .runFullCycle()
      .then((result) => {
        this.logger.log(
          `Lifecycle cycle complete: decayed=${result.decayed}, promoted=${result.promoted}, consolidated=${result.consolidated}, pruned=${result.pruned}`,
        );
      })
      .catch((err) => {
        this.logger.warn(`Lifecycle cycle failed: ${err instanceof Error ? err.message : String(err)}`);
      });

    // Identity reflection runs in parallel with general lifecycle (fire-and-forget)
    this.identityReflectionService
      .reflect()
      .then((result) => {
        if (result.contradictionsResolved + result.consolidated + result.promoted + result.pruned > 0) {
          this.logger.log(
            `Identity reflection complete: contradictions=${result.contradictionsResolved}, consolidated=${result.consolidated}, promoted=${result.promoted}, pruned=${result.pruned}`,
          );
        }
      })
      .catch((err) => {
        this.logger.warn(`Identity reflection failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }
}
