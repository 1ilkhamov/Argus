import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LOG_DIR } from '../common/logger/file-logger.service';
import { LogSearchService } from './log-search.service';

describe('LogSearchService', () => {
  const appFile = 'app-2099-12-30.log';
  const errorFile = 'error-2099-12-30.log';
  const appPath = join(LOG_DIR, appFile);
  const errorPath = join(LOG_DIR, errorFile);

  beforeAll(() => {
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }

    writeFileSync(appPath, [
      '2099-12-30 10:00:00.000 LOG     [HTTP] {"event":"http_request_completed","statusCode":200,"path":"/api/health"}',
      '2099-12-30 10:01:00.000 WARN    [TelegramWatchdogService] Alert already exists for this unanswered message; skipping duplicate notify.',
    ].join('\n'));

    writeFileSync(errorPath, [
      '2099-12-30 10:02:00.000 ERROR   [HttpExceptionFilter] {"event":"http_exception","statusCode":500,"message":"boom"}',
      'Error: boom',
      '    at test stack line',
    ].join('\n'));
  });

  afterAll(() => {
    rmSync(appPath, { force: true });
    rmSync(errorPath, { force: true });
  });

  it('lists filtered log files', () => {
    const service = new LogSearchService();

    const appFiles = service.listFiles('app');
    expect(appFiles).toContain(appFile);
    expect(appFiles).not.toContain(errorFile);
  });

  it('finds structured HTTP events by event name and date', () => {
    const service = new LogSearchService();

    const result = service.search({
      event: 'http_request_completed',
      date: '2099-12-30',
      fileKind: 'app',
      limit: 10,
    });

    expect(result.filesScanned).toContain(appFile);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual(expect.objectContaining({
      file: appFile,
      level: 'log',
      context: 'HTTP',
      event: 'http_request_completed',
    }));
  });

  it('parses multi-line error entries and filters by level', () => {
    const service = new LogSearchService();

    const result = service.search({
      level: 'error',
      date: '2099-12-30',
      fileKind: 'error',
      limit: 10,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual(expect.objectContaining({
      file: errorFile,
      level: 'error',
      context: 'HttpExceptionFilter',
      event: 'http_exception',
    }));
    expect(result.entries[0]?.message).toContain('Error: boom');
  });
});
