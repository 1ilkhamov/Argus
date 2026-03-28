import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, readFile, stat, unlink, writeFile } from 'fs/promises';
import { dirname, isAbsolute, resolve } from 'path';

import type { AgentUserProfile } from '../agent/profile/user-profile.types';
import type { Message } from '../chat/entities/message.entity';

export interface SerializedMessage {
  id: string;
  conversationId: string;
  role: Message['role'];
  content: string;
  createdAt: string;
}

export interface SerializedConversation {
  id: string;
  scopeKey?: string;
  title: string;
  messages: SerializedMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface SerializedAgentUserProfile {
  profileKey: string;
  profile: AgentUserProfile;
  updatedAt: string;
}

export interface ChatStoreData {
  conversations: SerializedConversation[];
  userProfiles: SerializedAgentUserProfile[];
}

@Injectable()
export class FileStoreService implements OnModuleInit {
  private readonly logger = new Logger(FileStoreService.name);
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const storageDriver = this.configService.get<string>('storage.driver', 'sqlite');
    if (storageDriver !== 'file') {
      return;
    }

    await this.ensureStoreExists();
  }

  getDataFilePath(): string {
    const configuredPath = this.configService.get<string>('storage.dataFilePath', 'data/chat-store.json');
    return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
  }

  async readStore(): Promise<ChatStoreData> {
    await this.ensureStoreExists();
    const filePath = this.getDataFilePath();
    const raw = await readFile(filePath, 'utf-8');
    if (!raw.trim()) {
      return { conversations: [], userProfiles: [] };
    }

    try {
      const parsed = JSON.parse(raw) as Partial<ChatStoreData>;
      return {
        conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
        userProfiles: Array.isArray(parsed.userProfiles) ? parsed.userProfiles : [],
      };
    } catch {
      const brokenFilePath = `${filePath}.broken`;
      await unlink(brokenFilePath).catch(() => undefined);
      await writeFile(brokenFilePath, raw, 'utf-8');
      await writeFile(
        filePath,
        JSON.stringify({ conversations: [], userProfiles: [], userFacts: [], episodicMemories: [], managedMemoryStates: [] }, null, 2),
        'utf-8',
      );
      this.logger.warn(`Chat store was corrupted and has been reset. Backup: ${brokenFilePath}`);
      return { conversations: [], userProfiles: [] };
    }
  }

  async writeStore(store: ChatStoreData): Promise<void> {
    const filePath = this.getDataFilePath();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
  }

  withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async ensureStoreExists(): Promise<void> {
    const filePath = this.getDataFilePath();
    await mkdir(dirname(filePath), { recursive: true });

    try {
      await stat(filePath);
    } catch {
      await writeFile(
        filePath,
        JSON.stringify({ conversations: [], userProfiles: [], userFacts: [], episodicMemories: [], managedMemoryStates: [] }, null, 2),
        'utf-8',
      );
      this.logger.log(`Created chat store at ${filePath}`);
    }
  }
}
