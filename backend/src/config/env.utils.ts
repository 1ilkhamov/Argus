import { readFileSync } from 'fs';

type EnvRecord = Record<string, string | undefined>;

export function resolveEnvValue(config: EnvRecord, key: string): string | undefined {
  const directValue = config[key];
  if (directValue !== undefined && directValue !== '') {
    return directValue;
  }

  const filePath = config[`${key}_FILE`];
  if (!filePath) {
    return undefined;
  }

  return readFileSync(filePath, 'utf-8').trim();
}
