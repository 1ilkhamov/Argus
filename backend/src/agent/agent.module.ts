import { Module } from '@nestjs/common';

import { AgentMetricsService } from './metrics/metrics.service';
import { ModeClassifier } from './modes/mode-classifier';
import { ModeSelector } from './modes/mode-selector';
import { RegexModeClassifier } from './modes/regex-mode-classifier';
import { UserProfileService } from './profile/user-profile.service';
import { ResponseComplianceService } from './response-compliance/compliance.service';
import { ResponseDirectivesService } from './response-directives/response-directives.service';
import { SoulConfigService } from './identity/config/soul-config.service';
import { SystemPromptBuilder } from './prompt/prompt.builder';

@Module({
  providers: [
    SoulConfigService,
    SystemPromptBuilder,
    ResponseDirectivesService,
    ResponseComplianceService,
    ModeSelector,
    UserProfileService,
    AgentMetricsService,
    RegexModeClassifier,
    {
      provide: ModeClassifier,
      useExisting: RegexModeClassifier,
    },
  ],
  exports: [
    SoulConfigService,
    SystemPromptBuilder,
    ResponseDirectivesService,
    ResponseComplianceService,
    ModeSelector,
    UserProfileService,
    AgentMetricsService,
  ],
})
export class AgentModule {}
