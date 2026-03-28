import { deriveScopeKey } from './scope-key';

describe('deriveScopeKey', () => {
  it('returns local:default when no API key is provided', () => {
    expect(deriveScopeKey(undefined)).toBe('local:default');
  });

  it('returns local:default for empty string', () => {
    expect(deriveScopeKey('')).toBe('local:default');
  });

  it('returns a key: prefixed hash for a valid API key', () => {
    const result = deriveScopeKey('my-secret-key');
    expect(result).toMatch(/^key:[0-9a-f]{16}$/);
  });

  it('returns deterministic output for the same key', () => {
    expect(deriveScopeKey('test-key')).toBe(deriveScopeKey('test-key'));
  });

  it('returns different scope keys for different API keys', () => {
    expect(deriveScopeKey('key-a')).not.toBe(deriveScopeKey('key-b'));
  });

  it('supports a session-prefixed scope key for public sessions', () => {
    expect(deriveScopeKey('session-123', 'session')).toMatch(/^session:[0-9a-f]{16}$/);
  });
});
