import { Injectable, Logger } from '@nestjs/common';
import { timingSafeEqual, randomBytes } from 'crypto';

import { HookRepository } from './hook.repository';
import type {
  WebhookHook,
  CreateHookParams,
  UpdateHookParams,
  HookFireContext,
  HookFireResult,
  HookMethod,
} from './hook.types';

/** Validates hook name: lowercase alphanumeric, hyphens, underscores, 3-64 chars */
const HOOK_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/;

/** Maximum number of hooks allowed */
const MAX_HOOKS = 100;

/**
 * Service layer for webhook CRUD and firing.
 *
 * The actual LLM execution is delegated to HookExecutorService
 * (set via setFireHandler, same pattern as CronSchedulerService).
 */
@Injectable()
export class HooksService {
  private readonly logger = new Logger(HooksService.name);

  /** Callback invoked when a hook fires. Set by HookExecutorService. */
  private onHookFired?: (ctx: HookFireContext) => Promise<HookFireResult>;

  constructor(private readonly repo: HookRepository) {}

  /** Register the execution handler (called by HookExecutorService on init) */
  setFireHandler(handler: (ctx: HookFireContext) => Promise<HookFireResult>): void {
    this.onHookFired = handler;
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────────

  async createHook(params: CreateHookParams): Promise<WebhookHook> {
    // Validate name
    if (!HOOK_NAME_RE.test(params.name)) {
      throw new Error(
        `Invalid hook name "${params.name}". Must be 3-64 chars, lowercase alphanumeric with hyphens/underscores, must start and end with alphanumeric.`,
      );
    }

    // Check for duplicate name
    const existing = await this.repo.findByName(params.name);
    if (existing) {
      throw new Error(`Hook "${params.name}" already exists (id: ${existing.id}).`);
    }

    // Enforce max hooks limit
    const all = await this.repo.findAll();
    if (all.length >= MAX_HOOKS) {
      throw new Error(`Maximum number of hooks (${MAX_HOOKS}) reached. Delete unused hooks first.`);
    }

    // Validate secret length
    if (!params.secret || params.secret.length < 8) {
      throw new Error('Hook secret must be at least 8 characters.');
    }

    // Validate prompt template
    if (!params.promptTemplate.trim()) {
      throw new Error('Prompt template cannot be empty.');
    }

    // Validate methods
    if (params.methods) {
      const validMethods: HookMethod[] = ['POST', 'PUT', 'GET'];
      for (const m of params.methods) {
        if (!validMethods.includes(m)) {
          throw new Error(`Invalid method "${m}". Allowed: ${validMethods.join(', ')}`);
        }
      }
    }

    const hook = await this.repo.create(params);
    this.logger.log(`Hook created: "${hook.name}" (${hook.id})`);
    return hook;
  }

  async getHook(id: string): Promise<WebhookHook | undefined> {
    return this.repo.findById(id);
  }

  async getHookByName(name: string): Promise<WebhookHook | undefined> {
    return this.repo.findByName(name);
  }

  async listHooks(): Promise<WebhookHook[]> {
    return this.repo.findAll();
  }

  async updateHook(id: string, updates: UpdateHookParams): Promise<WebhookHook | undefined> {
    const hook = await this.repo.findById(id);
    if (!hook) return undefined;

    if (updates.secret !== undefined && updates.secret.length < 8) {
      throw new Error('Hook secret must be at least 8 characters.');
    }

    if (updates.promptTemplate !== undefined && !updates.promptTemplate.trim()) {
      throw new Error('Prompt template cannot be empty.');
    }

    await this.repo.update(id, updates);
    return this.repo.findById(id);
  }

  async deleteHook(id: string): Promise<boolean> {
    const deleted = await this.repo.delete(id);
    if (deleted) {
      this.logger.log(`Hook deleted: ${id}`);
    }
    return deleted;
  }

  async pauseHook(id: string): Promise<WebhookHook | undefined> {
    const hook = await this.repo.findById(id);
    if (!hook) return undefined;
    await this.repo.update(id, { status: 'paused' });
    return { ...hook, status: 'paused' };
  }

  async resumeHook(id: string): Promise<WebhookHook | undefined> {
    const hook = await this.repo.findById(id);
    if (!hook) return undefined;
    await this.repo.update(id, { status: 'active' });
    return { ...hook, status: 'active' };
  }

  // ─── Fire ──────────────────────────────────────────────────────────────────

  /**
   * Validate the incoming request and fire the hook if everything checks out.
   * Returns the fire result or throws on validation failure.
   */
  async fireHook(
    hookName: string,
    method: string,
    payload: string,
    headers: Record<string, string>,
    query: Record<string, string>,
    sourceIp: string,
    authToken: string,
  ): Promise<HookFireResult> {
    // Find hook
    const hook = await this.repo.findByName(hookName);
    if (!hook) {
      throw new HookNotFoundError(`Hook "${hookName}" not found.`);
    }

    // Check status
    if (hook.status !== 'active') {
      throw new HookPausedError(`Hook "${hookName}" is paused.`);
    }

    // Check method
    if (!hook.methods.includes(method.toUpperCase() as HookMethod)) {
      throw new HookMethodNotAllowedError(
        `Method ${method} not allowed for hook "${hookName}". Allowed: ${hook.methods.join(', ')}`,
      );
    }

    // Verify secret (timing-safe comparison)
    if (!this.verifySecret(authToken, hook.secret)) {
      throw new HookAuthError(`Invalid token for hook "${hookName}".`);
    }

    // Check payload size
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    if (payloadBytes > hook.maxPayloadBytes) {
      throw new HookPayloadTooLargeError(
        `Payload too large (${payloadBytes} bytes). Max: ${hook.maxPayloadBytes} bytes.`,
      );
    }

    // Parse payload
    let parsedPayload: Record<string, unknown> | null = null;
    if (payload.trim()) {
      try {
        parsedPayload = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        // Not JSON — that's OK, will use raw string
      }
    }

    // Record the fire
    await this.repo.recordFire(hook.id);

    this.logger.log(`Hook "${hookName}" fired from ${sourceIp} (${method})`);

    // Execute via handler
    if (!this.onHookFired) {
      this.logger.warn(`No fire handler registered — hook "${hookName}" result dropped`);
      return {
        hookName,
        success: false,
        content: '',
        toolRoundsUsed: 0,
        durationMs: 0,
        error: 'No execution handler registered.',
      };
    }

    const ctx: HookFireContext = {
      hook,
      payload,
      parsedPayload,
      headers,
      query,
      method,
      sourceIp,
    };

    return this.onHookFired(ctx);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Generate a cryptographically random secret */
  static generateSecret(length = 32): string {
    return randomBytes(length).toString('hex');
  }

  /**
   * Timing-safe secret comparison to prevent timing attacks.
   */
  private verifySecret(provided: string, expected: string): boolean {
    if (!provided || !expected) return false;

    const providedBuf = Buffer.from(provided, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');

    if (providedBuf.length !== expectedBuf.length) {
      // Still do a comparison to keep timing constant-ish
      timingSafeEqual(expectedBuf, expectedBuf);
      return false;
    }

    return timingSafeEqual(providedBuf, expectedBuf);
  }
}

// ─── Error classes ─────────────────────────────────────────────────────────────

export class HookNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'HookNotFoundError'; }
}

export class HookPausedError extends Error {
  constructor(message: string) { super(message); this.name = 'HookPausedError'; }
}

export class HookMethodNotAllowedError extends Error {
  constructor(message: string) { super(message); this.name = 'HookMethodNotAllowedError'; }
}

export class HookAuthError extends Error {
  constructor(message: string) { super(message); this.name = 'HookAuthError'; }
}

export class HookPayloadTooLargeError extends Error {
  constructor(message: string) { super(message); this.name = 'HookPayloadTooLargeError'; }
}
