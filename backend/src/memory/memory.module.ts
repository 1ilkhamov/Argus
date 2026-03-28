import { Module } from '@nestjs/common';

import { AgentModule } from '../agent/agent.module';
import { EmbeddingModule } from '../embedding/embedding.module';
import { LlmModule } from '../llm/llm.module';
import { StorageModule } from '../storage/storage.module';
import { AdminApiKeyGuard } from '../common/guards/admin-api-key.guard';
import { AuthenticatedUserGuard } from '../common/guards/authenticated-user.guard';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { RateLimitService } from '../common/services/rate-limit.service';

// ─── Core ───────────────────────────────────────────────────────────────────
import { MemoryStoreService } from './core/memory-store.service';
import { QdrantVectorService } from './qdrant/qdrant-vector.service';

// ─── Recall + Capture ───────────────────────────────────────────────────────
import { AutoRecallService } from './recall/auto-recall.service';
import { AutoCaptureService } from './capture/pipeline/auto-capture.service';
import { MemoryExtractorV2Service } from './capture/pipeline/memory-extractor-v2.service';
import { ContradictionResolverService } from './capture/reconciliation/contradiction-resolver.service';

// ─── Identity ───────────────────────────────────────────────────────
import { IdentityExtractorService } from '../agent/identity/capture/identity-extractor.service';
import { IdentityCaptureService } from '../agent/identity/capture/identity-capture.service';
import { IdentityRecallService } from '../agent/identity/recall/identity-recall.service';
import { IdentityReflectionService } from '../agent/identity/reflection/identity-reflection.service';
import { SelfModelService } from '../agent/identity/reflection/self-model.service';

// ─── Action log ─────────────────────────────────────────────────────────────
import { ActionLoggerService } from './action-log/action-logger.service';
import { SessionReflectionService } from './action-log/session-reflection.service';

// ─── Memory tools ────────────────────────────────────────────────────────────
import { MemoryToolsService } from './tools/memory-tools.service';

// ─── Knowledge graph ────────────────────────────────────────────────────────
import { KnowledgeGraphService } from './knowledge-graph/knowledge-graph.service';
import { KgAutoUpdateService } from './knowledge-graph/sync/kg-auto-update.service';

// ─── Lifecycle + Controller ─────────────────────────────────────────────────
import { MemoryLifecycleV2Service } from './lifecycle/memory-lifecycle-v2.service';
import { MemoryLifecycleSchedulerService } from './lifecycle/memory-lifecycle-scheduler.service';
import { MemoryV2Controller } from './api/memory-v2.controller';

// ─── Archive + Commands ─────────────────────────────────────────────────────
import { ArchiveChatRetrieverService } from './archive/archive-chat-retriever.service';
import { ConversationalMemoryCommandService } from './commands/command.service';

@Module({
  imports: [AgentModule, EmbeddingModule, LlmModule, StorageModule],
  controllers: [MemoryV2Controller],
  providers: [
    MemoryStoreService,
    QdrantVectorService,
    AutoRecallService,
    AutoCaptureService,
    MemoryExtractorV2Service,
    ContradictionResolverService,
    IdentityExtractorService,
    IdentityCaptureService,
    IdentityRecallService,
    IdentityReflectionService,
    SelfModelService,
    KnowledgeGraphService,
    KgAutoUpdateService,
    MemoryLifecycleV2Service,
    MemoryLifecycleSchedulerService,
    ArchiveChatRetrieverService,
    ConversationalMemoryCommandService,
    MemoryToolsService,
    ActionLoggerService,
    SessionReflectionService,
    AdminApiKeyGuard,
    AuthenticatedUserGuard,
    RateLimitGuard,
    RateLimitService,
  ],
  exports: [
    MemoryStoreService,
    QdrantVectorService,
    AutoRecallService,
    AutoCaptureService,
    MemoryExtractorV2Service,
    IdentityCaptureService,
    IdentityRecallService,
    SelfModelService,
    KnowledgeGraphService,
    KgAutoUpdateService,
    MemoryLifecycleV2Service,
    ArchiveChatRetrieverService,
    ConversationalMemoryCommandService,
    MemoryToolsService,
    ActionLoggerService,
    SessionReflectionService,
  ],
})
export class MemoryModule {}
