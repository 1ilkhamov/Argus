import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CHAT_REPOSITORY } from '../chat/repositories/chat.repository';
import { FileTurnExecutionStateRepository } from '../chat/runtime/file-turn-execution-state.repository';
import { PostgresTurnExecutionStateRepository } from '../chat/runtime/postgres-turn-execution-state.repository';
import { SqliteTurnExecutionStateRepository } from '../chat/runtime/sqlite-turn-execution-state.repository';
import { TURN_EXECUTION_STATE_REPOSITORY } from '../chat/runtime/turn-execution-state.repository';
import { FileChatRepository } from '../chat/repositories/file-chat.repository';
import { PostgresChatRepository } from '../chat/repositories/postgres-chat.repository';
import { SqliteChatRepository } from '../chat/repositories/sqlite-chat.repository';
import { MEMORY_ENTRY_REPOSITORY } from '../memory/core/memory-entry.repository';
import { MEMORY_REPOSITORY } from '../memory/repositories/memory.repository';
import { FileMemoryRepository } from '../memory/repositories/file-memory.repository';
import { PostgresMemoryRepository } from '../memory/repositories/postgres-memory.repository';
import { SqliteMemoryRepository } from '../memory/repositories/sqlite-memory.repository';
import { KNOWLEDGE_GRAPH_REPOSITORY } from '../memory/knowledge-graph/repositories/knowledge-graph.repository';
import { PostgresKnowledgeGraphRepository } from '../memory/knowledge-graph/repositories/postgres-knowledge-graph.repository';
import { SqliteKnowledgeGraphRepository } from '../memory/knowledge-graph/repositories/sqlite-knowledge-graph.repository';
import { PostgresMemoryEntryRepository } from '../memory/core/postgres-memory-entry.repository';
import { SqliteMemoryEntryRepository } from '../memory/core/sqlite-memory-entry.repository';
import { FileStoreService } from './file-store.service';
import { PostgresConnectionService } from './postgres-connection.service';

@Module({
  providers: [
    PostgresConnectionService,
    FileStoreService,
    FileChatRepository,
    FileTurnExecutionStateRepository,
    PostgresChatRepository,
    PostgresTurnExecutionStateRepository,
    SqliteChatRepository,
    SqliteTurnExecutionStateRepository,
    FileMemoryRepository,
    PostgresMemoryRepository,
    SqliteMemoryRepository,
    PostgresMemoryEntryRepository,
    SqliteMemoryEntryRepository,
    PostgresKnowledgeGraphRepository,
    SqliteKnowledgeGraphRepository,
    {
      provide: KNOWLEDGE_GRAPH_REPOSITORY,
      inject: [ConfigService, SqliteKnowledgeGraphRepository, PostgresKnowledgeGraphRepository],
      useFactory: (
        configService: ConfigService,
        sqliteRepo: SqliteKnowledgeGraphRepository,
        postgresRepo: PostgresKnowledgeGraphRepository,
      ) => {
        const storageDriver = configService.get<string>('storage.driver', 'sqlite');
        if (storageDriver === 'postgres') {
          return postgresRepo;
        }
        return sqliteRepo;
      },
    },
    {
      provide: TURN_EXECUTION_STATE_REPOSITORY,
      inject: [
        ConfigService,
        FileTurnExecutionStateRepository,
        SqliteTurnExecutionStateRepository,
        PostgresTurnExecutionStateRepository,
      ],
      useFactory: (
        configService: ConfigService,
        fileRepository: FileTurnExecutionStateRepository,
        sqliteRepository: SqliteTurnExecutionStateRepository,
        postgresRepository: PostgresTurnExecutionStateRepository,
      ) => {
        const storageDriver = configService.get<string>('storage.driver', 'sqlite');
        if (storageDriver === 'file') {
          return fileRepository;
        }

        if (storageDriver === 'postgres') {
          return postgresRepository;
        }

        return sqliteRepository;
      },
    },
    {
      provide: CHAT_REPOSITORY,
      inject: [ConfigService, FileChatRepository, SqliteChatRepository, PostgresChatRepository],
      useFactory: (
        configService: ConfigService,
        fileRepository: FileChatRepository,
        sqliteRepository: SqliteChatRepository,
        postgresRepository: PostgresChatRepository,
      ) => {
        const storageDriver = configService.get<string>('storage.driver', 'sqlite');
        if (storageDriver === 'file') {
          return fileRepository;
        }

        if (storageDriver === 'postgres') {
          return postgresRepository;
        }

        return sqliteRepository;
      },
    },
    {
      provide: MEMORY_REPOSITORY,
      inject: [ConfigService, FileMemoryRepository, SqliteMemoryRepository, PostgresMemoryRepository],
      useFactory: (
        configService: ConfigService,
        fileRepository: FileMemoryRepository,
        sqliteRepository: SqliteMemoryRepository,
        postgresRepository: PostgresMemoryRepository,
      ) => {
        const storageDriver = configService.get<string>('storage.driver', 'sqlite');
        if (storageDriver === 'file') {
          return fileRepository;
        }

        if (storageDriver === 'postgres') {
          return postgresRepository;
        }

        return sqliteRepository;
      },
    },
    {
      provide: MEMORY_ENTRY_REPOSITORY,
      inject: [ConfigService, SqliteMemoryEntryRepository, PostgresMemoryEntryRepository],
      useFactory: (
        configService: ConfigService,
        sqliteRepo: SqliteMemoryEntryRepository,
        postgresRepo: PostgresMemoryEntryRepository,
      ) => {
        const storageDriver = configService.get<string>('storage.driver', 'sqlite');
        if (storageDriver === 'postgres') {
          return postgresRepo;
        }
        return sqliteRepo;
      },
    },
  ],
  exports: [
    PostgresConnectionService,
    FileStoreService,
    FileChatRepository,
    PostgresChatRepository,
    SqliteChatRepository,
    FileTurnExecutionStateRepository,
    PostgresTurnExecutionStateRepository,
    SqliteTurnExecutionStateRepository,
    FileMemoryRepository,
    PostgresMemoryRepository,
    SqliteMemoryRepository,
    PostgresMemoryEntryRepository,
    SqliteMemoryEntryRepository,
    PostgresKnowledgeGraphRepository,
    SqliteKnowledgeGraphRepository,
    KNOWLEDGE_GRAPH_REPOSITORY,
    CHAT_REPOSITORY,
    TURN_EXECUTION_STATE_REPOSITORY,
    MEMORY_REPOSITORY,
    MEMORY_ENTRY_REPOSITORY,
  ],
})
export class StorageModule {}
