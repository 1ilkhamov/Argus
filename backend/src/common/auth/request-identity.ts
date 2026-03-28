export interface RequestIdentity {
  /** Whether the request is authenticated (API key matched a known key) */
  authenticated: boolean;

  /** Role derived from the API key: 'admin' | 'user' | 'anonymous' */
  role: 'admin' | 'user' | 'anonymous';

  authType: 'none' | 'api_key' | 'public_session';

  /** Tenant isolation scope key (e.g. 'key:<hash>' or 'local:default') */
  scopeKey: string;

  /** Raw API key value (undefined if auth is disabled or no key was sent) */
  apiKey?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      identity?: RequestIdentity;
      requestId?: string;
      clientIp?: string;
    }
  }
}
