import { Injectable, Logger, Optional } from '@nestjs/common';

import type { Tool, ToolDefinition } from '../tool.types';
import type { ToolSafetyService } from '../safety/tool-safety.service';

/**
 * Central registry for all available tools.
 * Tools register themselves on module init; the registry is queried
 * by the prompt builder (to describe tools to the LLM) and by the
 * executor (to look up a tool by name).
 */
@Injectable()
export class ToolRegistryService {
  private readonly logger = new Logger(ToolRegistryService.name);
  private readonly tools = new Map<string, Tool>();

  private safetyService?: ToolSafetyService;

  /** Inject safety service after construction (avoids circular dependency). */
  setSafetyService(safety: ToolSafetyService): void {
    this.safetyService = safety;
  }

  /** Register a tool. Throws on duplicate name. */
  register(tool: Tool): void {
    const { name } = tool.definition;

    if (this.tools.has(name)) {
      throw new Error(`Tool "${name}" is already registered`);
    }

    this.tools.set(name, tool);
    this.logger.log(`Tool registered: ${name} (safety=${tool.definition.safety})`);
  }

  /** Look up a tool by name. */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Return tool definitions visible under the current safety policy.
   * Tools blocked by policy/blocklist are excluded so the LLM never sees them.
   */
  getDefinitions(): ToolDefinition[] {
    const all = [...this.tools.values()].map((t) => t.definition);
    if (!this.safetyService) return all;

    return all.filter((d) => this.safetyService!.isVisible(d.name, d.safety));
  }

  /** Return all registered tool names (unfiltered — for diagnostics). */
  getNames(): string[] {
    return [...this.tools.keys()];
  }

  /** How many tools are registered (unfiltered). */
  get size(): number {
    return this.tools.size;
  }
}
