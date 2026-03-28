import { Module, OnModuleInit } from '@nestjs/common';

import { LlmModule } from '../llm/llm.module';
import { SettingsModule } from '../settings/settings.module';
import { MemoryModule } from '../memory/memory.module';
import { CronModule } from '../cron/cron.module';
// ─── Core infrastructure ─────────────────────────────────────────────────────
import { ToolRegistryService } from './core/registry/tool-registry.service';
import { ToolExecutorService } from './core/execution/tool-executor.service';
import { ToolOrchestratorService } from './core/tool-orchestrator.service';
import { ToolSafetyService } from './core/safety/tool-safety.service';

// ─── Builtin: web ────────────────────────────────────────────────────────────
import { WebSearchTool } from './builtin/web/web-search.tool';
import { WebFetchTool } from './builtin/web/web-fetch.tool';
import { HttpRequestTool } from './builtin/web/http-request.tool';
import { BrowserTool } from './builtin/web/browser.tool';
import { BrowserSessionService } from './builtin/web/browser-session.service';

// ─── Builtin: memory ─────────────────────────────────────────────────────────
import { MemoryManageTool } from './builtin/memory/memory-manage.tool';
import { KnowledgeSearchTool } from './builtin/memory/knowledge-search.tool';

// ─── Builtin: system ─────────────────────────────────────────────────────────
import { SystemRunTool } from './builtin/system/system-run.tool';
import { FileOpsTool } from './builtin/system/file-ops.tool';
import { ClipboardTool } from './builtin/system/clipboard.tool';
import { NotifyTool } from './builtin/system/notify.tool';
import { VisionTool } from './builtin/system/vision.tool';
import { PdfReadTool } from './builtin/system/pdf-read.tool';
import { SqlQueryTool } from './builtin/system/sql-query.tool';
import { AppleScriptTool } from './builtin/system/applescript.tool';
import { ProcessManagerService } from './builtin/system/process-manager.service';
import { ProcessTool } from './builtin/system/process.tool';

// ─── Builtin: compute ────────────────────────────────────────────────────────
import { CalculatorTool } from './builtin/compute/calculator.tool';
import { CodeExecTool } from './builtin/compute/code-exec.tool';
import { DateTimeTool } from './builtin/compute/datetime.tool';
import { AudioTranscribeTool } from './builtin/compute/audio-transcribe.tool';
import { DocumentGenTool } from './builtin/compute/document-gen.tool';

// ─── Builtin: scheduling ─────────────────────────────────────────────────────
import { CronTool } from './builtin/scheduling/cron.tool';
import { CronExecutorService } from './builtin/scheduling/cron-executor.service';

// ─── Builtin: automation ─────────────────────────────────────────────────────
import { WebhookTool } from './builtin/automation/webhook.tool';
import { HookExecutorService } from '../hooks/hook-executor.service';
import { HooksModule } from '../hooks/hooks.module';

// ─── Builtin: communication ─────────────────────────────────────────────────
import { EmailTool } from './builtin/communication/email.tool';
import { EmailModule } from '../email/email.module';
// ─── Builtin: orchestration ─────────────────────────────────────────────────
import { SubAgentService } from './builtin/orchestration/sub-agent.service';
import { SubAgentTool } from './builtin/orchestration/sub-agent.tool';

import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { RateLimitService } from '../common/services/rate-limit.service';
import { ToolsController } from './api/tools.controller';
import { PendingNotifyService } from './core/pending-notify.service';

@Module({
  imports: [LlmModule, SettingsModule, MemoryModule, CronModule, HooksModule, EmailModule],
  controllers: [ToolsController],
  providers: [
    ToolSafetyService,
    ToolRegistryService,
    ToolExecutorService,
    ToolOrchestratorService,
    WebSearchTool,
    WebFetchTool,
    DateTimeTool,
    CalculatorTool,
    SystemRunTool,
    MemoryManageTool,
    NotifyTool,
    CronTool,
    FileOpsTool,
    ClipboardTool,
    VisionTool,
    CodeExecTool,
    KnowledgeSearchTool,
    HttpRequestTool,
    PdfReadTool,
    BrowserSessionService,
    BrowserTool,
    AudioTranscribeTool,
    SqlQueryTool,
    AppleScriptTool,
    DocumentGenTool,
    CronExecutorService,
    WebhookTool,
    HookExecutorService,
    EmailTool,
    ProcessManagerService,
    ProcessTool,
    SubAgentService,
    SubAgentTool,
    PendingNotifyService,
    ApiKeyGuard,
    RateLimitGuard,
    RateLimitService,
  ],
  exports: [
    ToolSafetyService,
    ToolRegistryService,
    ToolExecutorService,
    ToolOrchestratorService,
    PendingNotifyService,
  ],
})
export class ToolsModule implements OnModuleInit {
  constructor(
    private readonly registry: ToolRegistryService,
    private readonly safety: ToolSafetyService,
  ) {}

  onModuleInit(): void {
    this.registry.setSafetyService(this.safety);
  }
}
