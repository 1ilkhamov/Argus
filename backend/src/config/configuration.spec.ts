import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import configuration from './configuration';

describe('configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('resolves admin api key from AUTH_ADMIN_API_KEY_FILE', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'argus-config-'));

    try {
      const secretFile = join(tempDir, 'admin-api-key.txt');
      writeFileSync(secretFile, 'admin-secret\n', 'utf-8');
      delete process.env.AUTH_ADMIN_API_KEY;
      process.env.AUTH_ADMIN_API_KEY_FILE = secretFile;

      const result = configuration();

      expect(result.auth.adminApiKey).toBe('admin-secret');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
