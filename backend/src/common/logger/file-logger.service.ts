import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const LOG_DIR = resolve(process.cwd(), 'data', 'logs');

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function writeToFile(filename: string, line: string): void {
  try {
    appendFileSync(join(LOG_DIR, filename), line + '\n', 'utf8');
  } catch {
    // never crash the app over a log write failure
  }
}

function formatLine(level: string, message: unknown, context?: string): string {
  const ctx = context ? ` [${context}]` : '';
  return `${timestamp()} ${level.toUpperCase().padEnd(7)}${ctx} ${String(message)}`;
}

function hasContext(context?: string): context is string {
  return typeof context === 'string' && context.length > 0;
}

export class FileLoggerService extends ConsoleLogger {
  constructor() {
    super();
    ensureLogDir();
  }

  private write(level: string, message: unknown, context?: string): void {
    const line = formatLine(level, message, context);
    const today = todayString();
    writeToFile(`app-${today}.log`, line);
    if (level === 'error' || level === 'warn') {
      writeToFile(`error-${today}.log`, line);
    }
  }

  override log(message: unknown, context?: string): void {
    if (hasContext(context)) {
      super.log(message, context);
    } else {
      super.log(message);
    }
    this.write('log', message, context);
  }

  override error(message: unknown, stack?: string, context?: string): void {
    super.error(message, stack, context);
    const full = stack ? `${String(message)}\n${stack}` : message;
    this.write('error', full, context);
  }

  override warn(message: unknown, context?: string): void {
    if (hasContext(context)) {
      super.warn(message, context);
    } else {
      super.warn(message);
    }
    this.write('warn', message, context);
  }

  override debug(message: unknown, context?: string): void {
    if (hasContext(context)) {
      super.debug(message, context);
    } else {
      super.debug(message);
    }
    this.write('debug', message, context);
  }

  override verbose(message: unknown, context?: string): void {
    if (hasContext(context)) {
      super.verbose(message, context);
    } else {
      super.verbose(message);
    }
    this.write('verbose', message, context);
  }

  override fatal(message: unknown, context?: string): void {
    if (hasContext(context)) {
      super.fatal(message, context);
    } else {
      super.fatal(message);
    }
    this.write('fatal', message, context);
  }

  setLogLevels(levels: LogLevel[]): void {
    super.setLogLevels(levels);
  }
}
