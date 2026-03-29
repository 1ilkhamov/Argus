import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const LOG_DIR = resolve(process.cwd(), 'data', 'logs');

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
    super.log(message, context);
    this.write('log', message, context);
  }

  override error(message: unknown, stack?: string, context?: string): void {
    super.error(message, stack, context);
    const full = stack ? `${String(message)}\n${stack}` : message;
    this.write('error', full, context);
  }

  override warn(message: unknown, context?: string): void {
    super.warn(message, context);
    this.write('warn', message, context);
  }

  override debug(message: unknown, context?: string): void {
    super.debug(message, context);
    this.write('debug', message, context);
  }

  override verbose(message: unknown, context?: string): void {
    super.verbose(message, context);
    this.write('verbose', message, context);
  }

  override fatal(message: unknown, context?: string): void {
    super.fatal(message, context);
    this.write('fatal', message, context);
  }

  setLogLevels(levels: LogLevel[]): void {
    super.setLogLevels(levels);
  }
}
