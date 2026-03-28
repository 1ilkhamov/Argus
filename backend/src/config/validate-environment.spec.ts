import { validateEnvironment } from './validate-environment';

describe('validateEnvironment', () => {
  it('fills safe defaults for development', () => {
    const result = validateEnvironment({});

    expect(result.NODE_ENV).toBe('development');
    expect(result.PORT).toBe('2901');
    expect(result.AUTH_ENABLED).toBe('false');
    expect(result.RATE_LIMIT_ENABLED).toBe('true');
    expect(result.STORAGE_DATA_FILE).toBe('data/chat-store.json');
    expect(result.STORAGE_MEMORY_DB_FILE).toBe('data/memory.db');
    expect(result.EMBEDDING_ENABLED).toBe('false');
  });

  it('requires embedding model when embedding is enabled', () => {
    expect(() =>
      validateEnvironment({
        EMBEDDING_ENABLED: 'true',
      }),
    ).toThrow('EMBEDDING_MODEL must be set when EMBEDDING_ENABLED=true');
  });

  it('accepts embedding config when model is provided', () => {
    const result = validateEnvironment({
      EMBEDDING_ENABLED: 'true',
      EMBEDDING_MODEL: 'text-embedding-3-small',
    });

    expect(result.EMBEDDING_ENABLED).toBe('true');
    expect(result.EMBEDDING_MODEL).toBe('text-embedding-3-small');
  });

  it('requires postgres url when postgres storage is enabled', () => {
    expect(() =>
      validateEnvironment({
        STORAGE_DRIVER: 'postgres',
      }),
    ).toThrow('STORAGE_POSTGRES_URL must be provided when STORAGE_DRIVER=postgres');
  });

  it('requires redis url when redis rate limit backend is enabled', () => {
    expect(() =>
      validateEnvironment({
        RATE_LIMIT_BACKEND: 'redis',
      }),
    ).toThrow('RATE_LIMIT_REDIS_URL must be provided when RATE_LIMIT_BACKEND=redis');
  });

  it('requires API keys when auth is enabled', () => {
    expect(() =>
      validateEnvironment({
        AUTH_ENABLED: 'true',
      }),
    ).toThrow('AUTH_API_KEYS must be provided when authentication is enabled unless public sessions are enabled');
  });

  it('allows auth without API keys when public sessions are enabled with a secret', () => {
    const result = validateEnvironment({
      AUTH_ENABLED: 'true',
      AUTH_PUBLIC_SESSIONS_ENABLED: 'true',
      AUTH_PUBLIC_SESSION_SECRET: 'session-secret',
    });

    expect(result.AUTH_ENABLED).toBe('true');
    expect(result.AUTH_PUBLIC_SESSIONS_ENABLED).toBe('true');
  });

  it('requires a public session secret when public sessions are enabled', () => {
    expect(() =>
      validateEnvironment({
        AUTH_ENABLED: 'true',
        AUTH_PUBLIC_SESSIONS_ENABLED: 'true',
      }),
    ).toThrow('AUTH_PUBLIC_SESSION_SECRET must be provided when AUTH_PUBLIC_SESSIONS_ENABLED=true');
  });

  it('rejects negative trusted proxy hops', () => {
    expect(() =>
      validateEnvironment({
        TRUST_PROXY_HOPS: '-1',
      }),
    ).toThrow('TRUST_PROXY_HOPS must be a non-negative integer');
  });

  it('requires production secrets in production', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        LLM_PROVIDER: 'openai',
        AUTH_ENABLED: 'true',
        AUTH_API_KEYS: 'secret',
        LLM_API_KEY: 'proxypal-local',
      }),
    ).toThrow('LLM_API_KEY must be set to a real secret in production');
  });
});
