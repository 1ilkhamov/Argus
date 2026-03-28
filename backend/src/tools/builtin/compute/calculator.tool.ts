import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { evaluate, format } from 'mathjs';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';

/** Maximum expression length to prevent abuse */
const MAX_EXPRESSION_LENGTH = 500;

/** Maximum operand value for factorial to prevent CPU DoS */
const MAX_FACTORIAL_OPERAND = 170;

/** Keywords that must not appear in expressions (scope extension, code execution) */
const BLOCKED_KEYWORDS = /\b(import|createUnit|simplify|derivative|parse|compile|evaluate|chain|help|typeof)\b/i;

/** Pattern to detect huge factorial operands like 99999! */
const FACTORIAL_PATTERN = /(\d+)\s*!/g;

@Injectable()
export class CalculatorTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(CalculatorTool.name);

  readonly definition: ToolDefinition = {
    name: 'calculator',
    description:
      'Evaluate mathematical expressions safely. Supports arithmetic (+, -, *, /, ^, %), functions (sqrt, sin, cos, tan, log, abs, round, ceil, floor, etc.), constants (pi, e), unit conversions (e.g. "5 inches to cm", "100 km/h to m/s"), and percentages. Use this whenever you need to compute an exact numerical result instead of estimating.',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description:
            'The mathematical expression to evaluate. Examples: "2^10", "sqrt(144)", "sin(pi/4)", "5 inches to cm", "15% of 200", "100 * (1 + 0.05)^10".',
        },
      },
      required: ['expression'],
    },
    safety: 'safe',
  };

  constructor(private readonly registry: ToolRegistryService) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.logger.log('Calculator tool registered');
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const expression = String(args.expression ?? '').trim();

    if (!expression) {
      return 'Error: No expression provided. Example: "2 + 2", "sqrt(144)", "5 inches to cm".';
    }

    if (expression.length > MAX_EXPRESSION_LENGTH) {
      return `Error: Expression too long (${expression.length} chars, max ${MAX_EXPRESSION_LENGTH}).`;
    }

    if (BLOCKED_KEYWORDS.test(expression)) {
      return 'Error: Expression contains a disallowed keyword.';
    }

    // Block huge factorials that would exhaust CPU/memory
    let factorialMatch: RegExpExecArray | null;
    while ((factorialMatch = FACTORIAL_PATTERN.exec(expression)) !== null) {
      const operand = Number(factorialMatch[1]);
      if (operand > MAX_FACTORIAL_OPERAND) {
        return `Error: Factorial operand ${operand} is too large (max ${MAX_FACTORIAL_OPERAND}).`;
      }
    }

    try {
      const result = evaluate(expression);
      const formatted = format(result, { precision: 14 });

      return [
        `Expression: ${expression}`,
        `Result: ${formatted}`,
      ].join('\n');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error evaluating "${expression}": ${message}`;
    }
  }
}
