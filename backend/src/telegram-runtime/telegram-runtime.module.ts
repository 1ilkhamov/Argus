import { Module } from '@nestjs/common';

import { AdminApiKeyGuard } from '../common/guards/admin-api-key.guard';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { RateLimitService } from '../common/services/rate-limit.service';
import { TelegramOutboundAuditController } from './telegram-outbound-audit.controller';
import { TelegramOutboundAuditRepository } from './telegram-outbound-audit.repository';
import { TelegramOutboundService } from './telegram-outbound.service';
import { TelegramPolicyService } from './telegram-policy.service';

@Module({
  controllers: [TelegramOutboundAuditController],
  providers: [
    TelegramPolicyService,
    TelegramOutboundAuditRepository,
    TelegramOutboundService,
    AdminApiKeyGuard,
    RateLimitGuard,
    RateLimitService,
  ],
  exports: [TelegramPolicyService, TelegramOutboundAuditRepository, TelegramOutboundService],
})
export class TelegramRuntimeModule {}
