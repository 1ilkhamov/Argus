import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdirSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { createClient, type RedisClientType } from 'redis';

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly backend: 'memory' | 'sqlite' | 'redis';
  private readonly database?: DatabaseSync;
  private redisClient?: RedisClientType;

  constructor(private readonly configService: ConfigService) {
    this.backend = this.configService.get<'memory' | 'sqlite' | 'redis'>('rateLimit.backend', 'sqlite');

    if (this.backend === 'sqlite') {
      const filePath = this.getStoreFilePath();
      mkdirSync(dirname(filePath), { recursive: true });
      this.database = new DatabaseSync(filePath);
      this.database.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS rate_limit_buckets (
          bucket_key TEXT PRIMARY KEY,
          count INTEGER NOT NULL,
          reset_at INTEGER NOT NULL
        );
      `);
    }

    if (this.backend === 'redis') {
      const redisUrl = this.configService.get<string>('rateLimit.redisUrl', '');
      if (!redisUrl) {
        throw new Error('Redis rate limit backend is not configured');
      }

      this.redisClient = createClient({ url: redisUrl });
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redisClient?.isOpen) {
      await this.redisClient.quit();
    }

    this.database?.close();
  }

  async consume(key: string, now = Date.now()): Promise<{
    allowed: boolean;
    remaining: number;
    resetAt: number;
    limit: number;
  }> {
    const enabled = this.configService.get<boolean>('rateLimit.enabled', true);
    const limit = this.configService.get<number>('rateLimit.maxRequests', 60);
    const windowMs = this.configService.get<number>('rateLimit.windowMs', 60000);

    if (!enabled) {
      return {
        allowed: true,
        remaining: limit,
        resetAt: now + windowMs,
        limit,
      };
    }

    if (this.backend === 'sqlite' && this.database) {
      return this.consumeWithSqlite(key, limit, windowMs, now);
    }

    if (this.backend === 'redis' && this.redisClient) {
      return this.consumeWithRedis(key, limit, windowMs, now);
    }

    this.pruneExpiredBuckets(now);

    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) {
      const nextBucket: RateLimitBucket = {
        count: 1,
        resetAt: now + windowMs,
      };
      this.buckets.set(key, nextBucket);
      return {
        allowed: true,
        remaining: Math.max(limit - 1, 0),
        resetAt: nextBucket.resetAt,
        limit,
      };
    }

    current.count += 1;
    this.buckets.set(key, current);

    return {
      allowed: current.count <= limit,
      remaining: Math.max(limit - current.count, 0),
      resetAt: current.resetAt,
      limit,
    };
  }

  private consumeWithSqlite(
    key: string,
    limit: number,
    windowMs: number,
    now: number,
  ): {
    allowed: boolean;
    remaining: number;
    resetAt: number;
    limit: number;
  } {
    const database = this.database;
    if (!database) {
      throw new Error('SQLite rate limit backend is not initialized');
    }

    database.prepare('DELETE FROM rate_limit_buckets WHERE reset_at <= ?').run(now);

    const current = database
      .prepare('SELECT count, reset_at FROM rate_limit_buckets WHERE bucket_key = ?')
      .get(key) as { count: number; reset_at: number } | undefined;

    if (!current || current.reset_at <= now) {
      const resetAt = now + windowMs;
      database
        .prepare(
          `
            INSERT INTO rate_limit_buckets (bucket_key, count, reset_at)
            VALUES (?, 1, ?)
            ON CONFLICT(bucket_key) DO UPDATE SET
              count = excluded.count,
              reset_at = excluded.reset_at
          `,
        )
        .run(key, resetAt);

      return {
        allowed: true,
        remaining: Math.max(limit - 1, 0),
        resetAt,
        limit,
      };
    }

    const nextCount = current.count + 1;
    database.prepare('UPDATE rate_limit_buckets SET count = ? WHERE bucket_key = ?').run(nextCount, key);

    return {
      allowed: nextCount <= limit,
      remaining: Math.max(limit - nextCount, 0),
      resetAt: current.reset_at,
      limit,
    };
  }

  private async consumeWithRedis(
    key: string,
    limit: number,
    windowMs: number,
    now: number,
  ): Promise<{
    allowed: boolean;
    remaining: number;
    resetAt: number;
    limit: number;
  }> {
    const client = this.redisClient;
    if (!client) {
      throw new Error('Redis rate limit backend is not initialized');
    }

    if (!client.isOpen) {
      await client.connect();
    }

    const result = (await client.eval(
      `
        local current = redis.call('INCR', KEYS[1])
        if current == 1 then
          redis.call('PEXPIRE', KEYS[1], ARGV[1])
        end
        local ttl = redis.call('PTTL', KEYS[1])
        return { current, ttl }
      `,
      {
        keys: [key],
        arguments: [String(windowMs)],
      },
    )) as [number | string, number | string];

    const current = Number(result[0] ?? 0);
    const ttl = Math.max(Number(result[1] ?? windowMs), 0);

    return {
      allowed: current <= limit,
      remaining: Math.max(limit - current, 0),
      resetAt: now + ttl,
      limit,
    };
  }

  private pruneExpiredBuckets(now: number): void {
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }

  private getStoreFilePath(): string {
    const configuredPath = this.configService.get<string>('rateLimit.storeFilePath', 'data/rate-limit.db');
    return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
  }
}
