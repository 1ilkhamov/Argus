import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CHAT_REPOSITORY } from '../chat/repositories/chat.repository';
import { FileChatRepository } from '../chat/repositories/file-chat.repository';
import { PostgresChatRepository } from '../chat/repositories/postgres-chat.repository';
import { SqliteChatRepository } from '../chat/repositories/sqlite-chat.repository';
import { MEMORY_ENTRY_REPOSITORY } from '../memory/core/memory-entry.repository';
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
    PostgresChatRepository,
    SqliteChatRepository,
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
    PostgresMemoryEntryRepository,
    SqliteMemoryEntryRepository,
    PostgresKnowledgeGraphRepository,
    SqliteKnowledgeGraphRepository,
    KNOWLEDGE_GRAPH_REPOSITORY,
    CHAT_REPOSITORY,
    MEMORY_ENTRY_REPOSITORY,
  ],
})
export class StorageModule {}
