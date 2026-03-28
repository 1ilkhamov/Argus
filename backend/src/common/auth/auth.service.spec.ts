import { ConfigService } from '@nestjs/config';

import { AuthService } from './auth.service';

const createRequest = (headers: Record<string, string> = {}, path = '/api/chat/messages') =>
  ({
    header: (name: string) => headers[name.toLowerCase()],
    path,
    url: path,
  }) as unknown as import('express').Request;

const createResponse = () => ({
  cookie: jest.fn(),
}) as unknown as import('express').Response;

describe('AuthService', () => {
  describe('when auth is disabled', () => {
    const service = new AuthService(
      new ConfigService({ auth: { enabled: false, apiKeys: ['key-a'], adminApiKey: 'admin-key' } }),
    );

    it('returns authenticated admin identity without API key', () => {
      const identity = service.resolveIdentity(createRequest());
      expect(identity.authenticated).toBe(true);
      expect(identity.role).toBe('admin');
      expect(identity.authType).toBe('none');
      expect(identity.scopeKey).toBe('local:default');
    });

    it('still derives scopeKey from provided key even when auth is off', () => {
      const identity = service.resolveIdentity(createRequest({ 'x-api-key': 'key-a' }));
      expect(identity.authenticated).toBe(true);
      expect(identity.authType).toBe('api_key');
      expect(identity.scopeKey).toMatch(/^key:[0-9a-f]{16}$/);
    });
  });

  describe('when auth is enabled', () => {
    const service = new AuthService(
      new ConfigService({ auth: { enabled: true, apiKeys: ['key-a', 'key-b'], adminApiKey: 'admin-key' } }),
    );

    it('returns anonymous for missing API key', () => {
      const identity = service.resolveIdentity(createRequest());
      expect(identity.authenticated).toBe(false);
      expect(identity.role).toBe('anonymous');
      expect(identity.authType).toBe('none');
      expect(identity.scopeKey).toBe('local:default');
    });

    it('returns anonymous for unknown API key', () => {
      const identity = service.resolveIdentity(createRequest({ 'x-api-key': 'bad-key' }));
      expect(identity.authenticated).toBe(false);
      expect(identity.role).toBe('anonymous');
      expect(identity.authType).toBe('api_key');
    });

    it('returns user role for a valid public API key', () => {
      const identity = service.resolveIdentity(createRequest({ 'x-api-key': 'key-a' }));
      expect(identity.authenticated).toBe(true);
      expect(identity.role).toBe('user');
      expect(identity.authType).toBe('api_key');
      expect(identity.scopeKey).toMatch(/^key:[0-9a-f]{16}$/);
      expect(identity.apiKey).toBe('key-a');
    });

    it('returns admin role for the admin API key', () => {
      const identity = service.resolveIdentity(createRequest({ 'x-api-key': 'admin-key' }));
      expect(identity.authenticated).toBe(true);
      expect(identity.role).toBe('admin');
      expect(identity.authType).toBe('api_key');
      expect(identity.apiKey).toBe('admin-key');
    });

    it('extracts API key from Bearer authorization header', () => {
      const identity = service.resolveIdentity(createRequest({ authorization: 'Bearer key-b' }));
      expect(identity.authenticated).toBe(true);
      expect(identity.role).toBe('user');
      expect(identity.apiKey).toBe('key-b');
    });

    it('prefers x-api-key over authorization header', () => {
      const identity = service.resolveIdentity(
        createRequest({ 'x-api-key': 'key-a', authorization: 'Bearer admin-key' }),
      );
      expect(identity.role).toBe('user');
      expect(identity.apiKey).toBe('key-a');
    });

    it('returns different scopeKeys for different API keys', () => {
      const a = service.resolveIdentity(createRequest({ 'x-api-key': 'key-a' }));
      const b = service.resolveIdentity(createRequest({ 'x-api-key': 'key-b' }));
      expect(a.scopeKey).not.toBe(b.scopeKey);
    });
  });

  describe('when public sessions are enabled', () => {
    const service = new AuthService(
      new ConfigService({
        nodeEnv: 'test',
        auth: {
          enabled: true,
          apiKeys: [],
          adminApiKey: 'admin-key',
          publicSessionsEnabled: true,
          publicSessionSecret: 'session-secret',
          publicSessionCookieName: 'argus_public_session',
          publicSessionTtlDays: 30,
        },
      }),
    );

    it('issues a public-session cookie for chat paths without an API key', () => {
      const response = createResponse();
      const identity = service.resolveIdentity(createRequest(), response);

      expect(identity.authenticated).toBe(true);
      expect(identity.role).toBe('user');
      expect(identity.authType).toBe('public_session');
      expect(identity.scopeKey).toMatch(/^session:[0-9a-f]{16}$/);
      expect(response.cookie).toHaveBeenCalledTimes(1);
    });

    it('reuses a valid public-session cookie without issuing a new one', () => {
      const response = createResponse();
      service.resolveIdentity(createRequest(), response);
      const token = (response.cookie as jest.Mock).mock.calls[0]?.[1] as string;

      const nextResponse = createResponse();
      const identity = service.resolveIdentity(
        createRequest({ cookie: `argus_public_session=${token}` }),
        nextResponse,
      );

      expect(identity.authenticated).toBe(true);
      expect(identity.authType).toBe('public_session');
      expect(nextResponse.cookie).not.toHaveBeenCalled();
    });

    it('does not create public sessions for non-chat paths', () => {
      const response = createResponse();
      const identity = service.resolveIdentity(createRequest({}, '/api/health/runtime'), response);

      expect(identity.authenticated).toBe(false);
      expect(identity.role).toBe('anonymous');
      expect(response.cookie).not.toHaveBeenCalled();
    });
  });

  describe('when auth is enabled without admin key', () => {
    const service = new AuthService(
      new ConfigService({ auth: { enabled: true, apiKeys: ['key-a'], adminApiKey: '' } }),
    );

    it('returns user role for valid key when no admin key is configured', () => {
      const identity = service.resolveIdentity(createRequest({ 'x-api-key': 'key-a' }));
      expect(identity.authenticated).toBe(true);
      expect(identity.role).toBe('user');
    });
  });
});
