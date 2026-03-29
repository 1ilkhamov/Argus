import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';
import { HooksService } from '../../../hooks/hooks.service';
import type { HookMethod } from '../../../hooks/hook.types';

/**
 * Agent-facing tool for managing webhook endpoints.
 *
 * Allows the agent to create, list, update, delete, pause, and resume webhooks.
 * When a webhook fires (external HTTP request), the hook's prompt template
 * is interpolated with the request data and sent to the LLM for processing.
 */
@Injectable()
export class WebhookTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(WebhookTool.name);
  private readonly enabled: boolean;

  readonly definition: ToolDefinition = {
    name: 'webhook',
    description:
      'Manage webhook endpoints for event-driven automation. External services (GitHub, Stripe, monitoring, etc.) can send HTTP requests to these endpoints, which trigger the agent to process the event.\n\n' +
      'Endpoint format: POST /api/hooks/<name>\n' +
      'Auth: external callers send the hook secret via Authorization: Bearer <token> or x-hook-token header.\n\n' +
      'Prompt template supports placeholders:\n' +
      '- {{payload}} — raw request body\n' +
      '- {{payload.key}} — dot-notation access into JSON body\n' +
      '- {{headers.x-github-event}} — request header\n' +
      '- {{query.param}} — query string parameter\n' +
      '- {{method}}, {{source_ip}}, {{hook_name}}',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: "create", "list", "delete", "pause", "resume", "update", or "generate_secret".',
          enum: ['create', 'list', 'delete', 'pause', 'resume', 'update', 'generate_secret'],
        },
        name: {
          type: 'string',
          description: 'URL-safe hook name (for "create"). 3-64 chars, lowercase alphanumeric with hyphens/underscores. E.g. "github-push", "stripe_payment".',
        },
        description: {
          type: 'string',
          description: 'Human-readable description (for "create"/"update").',
        },
        prompt_template: {
          type: 'string',
          description: 'Prompt template with {{placeholders}} (for "create"/"update"). This is what the agent receives when the webhook fires. E.g. "New GitHub push to {{payload.repository.full_name}} by {{payload.pusher.name}}: analyze the changes in {{payload}}".',
        },
        secret: {
          type: 'string',
          description: 'Authentication secret for external callers (for "create"/"update"). Min 8 chars. Use "generate_secret" action to get a random one.',
        },
        methods: {
          type: 'string',
          description: 'Comma-separated HTTP methods allowed (for "create"/"update"). Default: "POST". Options: POST, PUT, GET.',
        },
        notify: {
          type: 'boolean',
          description: 'Whether to send notification when hook fires (for "create"/"update"). Default: true.',
        },
        id: {
          type: 'string',
          description: 'Hook ID (for "delete", "pause", "resume", "update").',
        },
      },
      required: ['action'],
    },
    safety: 'moderate',
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly hooksService: HooksService,
    private readonly configService: ConfigService,
  ) {
    this.enabled = this.configService.get<boolean>('hooks.enabled', true);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('webhook tool disabled (hooks.enabled=false)');
      return;
    }
    this.registry.register(this);
    this.logger.log('webhook tool registered');
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    if (!this.enabled) {
      return 'Error: Webhooks are disabled. Set HOOKS_ENABLED=true to enable.';
    }

    const action = String(args.action ?? '');

    try {
      switch (action) {
        case 'create':
          return await this.handleCreate(args);
        case 'list':
          return await this.handleList();
        case 'delete':
          return await this.handleDelete(args);
        case 'pause':
          return await this.handlePause(args);
        case 'resume':
          return await this.handleResume(args);
        case 'update':
          return await this.handleUpdate(args);
        case 'generate_secret':
          return this.handleGenerateSecret();
        default:
          return `Unknown action: "${action}". Use "create", "list", "delete", "pause", "resume", "update", or "generate_secret".`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`webhook ${action} failed: ${message}`);
      return `Error: ${message}`;
    }
  }

  private async handleCreate(args: Record<string, unknown>): Promise<string> {
    const name = String(args.name ?? '').trim();
    const description = String(args.description ?? '').trim();
    const promptTemplate = String(args.prompt_template ?? '').trim();
    const secret = String(args.secret ?? '').trim();
    const methodsStr = String(args.methods ?? 'POST').trim();
    const notify = args.notify !== false;

    if (!name) return 'Error: "name" is required for create.';
    if (!promptTemplate) return 'Error: "prompt_template" is required for create.';
    if (!secret) return 'Error: "secret" is required for create. Use action "generate_secret" to get a random one.';

    const methods = methodsStr.split(',').map((m) => m.trim().toUpperCase()) as HookMethod[];

    const hook = await this.hooksService.createHook({
      name,
      description,
      promptTemplate,
      secret,
      methods,
      notifyOnFire: notify,
    });

    const port = this.configService.get<number>('port', 2901);

    const lines = [
      'Webhook created successfully.',
      `ID: ${hook.id}`,
      `Name: ${hook.name}`,
      `Endpoint: POST http://localhost:${port}/api/hooks/${hook.name}`,
      `Methods: ${hook.methods.join(', ')}`,
      `Notify: ${hook.notifyOnFire ? 'yes' : 'no'}`,
      '',
      'External callers should authenticate with:',
      `  Authorization: Bearer <secret>`,
      `  or x-hook-token: <secret>`,
      '',
      `Template: ${hook.promptTemplate.slice(0, 200)}${hook.promptTemplate.length > 200 ? '...' : ''}`,
    ];
    return lines.join('\n');
  }

  private async handleList(): Promise<string> {
    const hooks = await this.hooksService.listHooks();

    if (hooks.length === 0) return 'No webhooks configured.';

    const lines = [`${hooks.length} webhook(s):\n`];

    for (const hook of hooks) {
      const status = hook.status === 'active' ? '✅ active' : '⏸ paused';
      lines.push(`- **${hook.name}** (${status})`);
      lines.push(`  ID: ${hook.id}`);
      lines.push(`  Endpoint: /api/hooks/${hook.name}`);
      lines.push(`  Methods: ${hook.methods.join(', ')}`);
      lines.push(`  Description: ${hook.description || '—'}`);
      lines.push(`  Fired: ${hook.fireCount} time(s)`);
      lines.push(`  Last: ${hook.lastFiredAt ?? 'never'}`);
      lines.push(`  Notify: ${hook.notifyOnFire ? 'yes' : 'no'}`);
      lines.push('');
    }

    return lines.join('\n').trim();
  }

  private async handleDelete(args: Record<string, unknown>): Promise<string> {
    const id = String(args.id ?? '').trim();
    if (!id) return 'Error: "id" is required for delete. Use "list" to see hook IDs.';

    const deleted = await this.hooksService.deleteHook(id);
    return deleted ? `Hook ${id} deleted.` : `Hook ${id} not found.`;
  }

  private async handlePause(args: Record<string, unknown>): Promise<string> {
    const id = String(args.id ?? '').trim();
    if (!id) return 'Error: "id" is required for pause.';

    const hook = await this.hooksService.pauseHook(id);
    return hook ? `Hook "${hook.name}" paused.` : `Hook ${id} not found.`;
  }

  private async handleResume(args: Record<string, unknown>): Promise<string> {
    const id = String(args.id ?? '').trim();
    if (!id) return 'Error: "id" is required for resume.';

    const hook = await this.hooksService.resumeHook(id);
    return hook ? `Hook "${hook.name}" resumed.` : `Hook ${id} not found.`;
  }

  private async handleUpdate(args: Record<string, unknown>): Promise<string> {
    const id = String(args.id ?? '').trim();
    if (!id) return 'Error: "id" is required for update.';

    const updates: Record<string, unknown> = {};

    if (args.description !== undefined) updates.description = String(args.description).trim();
    if (args.prompt_template !== undefined) updates.promptTemplate = String(args.prompt_template).trim();
    if (args.secret !== undefined) updates.secret = String(args.secret).trim();
    if (args.notify !== undefined) updates.notifyOnFire = Boolean(args.notify);
    if (args.methods !== undefined) {
      updates.methods = String(args.methods).split(',').map((m) => m.trim().toUpperCase());
    }

    if (Object.keys(updates).length === 0) {
      return 'Error: No fields to update. Provide description, prompt_template, secret, methods, or notify.';
    }

    const hook = await this.hooksService.updateHook(id, updates);
    return hook ? `Hook "${hook.name}" updated.` : `Hook ${id} not found.`;
  }

  private handleGenerateSecret(): string {
    const secret = HooksService.generateSecret();
    return `Generated secret (32 bytes, hex):\n${secret}\n\nUse this as the "secret" parameter when creating a hook.`;
  }
}
