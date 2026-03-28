import { createHash } from 'crypto';

const DEFAULT_LOCAL_MEMORY_SCOPE = 'local:default';

export function deriveScopeKey(
  principal: string | undefined,
  prefix: 'key' | 'session' | 'telegram' = 'key',
): string {
  if (!principal) {
    return DEFAULT_LOCAL_MEMORY_SCOPE;
  }

  const hash = createHash('sha256').update(principal).digest('hex').slice(0, 16);
  return `${prefix}:${hash}`;
}
