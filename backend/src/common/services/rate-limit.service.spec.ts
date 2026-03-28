import { ConfigService } from '@nestjs/config';

import { RateLimitService } from './rate-limit.service';

describe('RateLimitService', () => {
  const createService = () =>
    new RateLimitService(
      new ConfigService({
        rateLimit: {
          enabled: true,
          maxRequests: 2,
          windowMs: 1000,
          backend: 'memory',
        },
      }),
    );

  it('allows requests up to the configured limit', async () => {
    const service = createService();

    expect((await service.consume('ip:route', 0)).allowed).toBe(true);
    expect((await service.consume('ip:route', 1)).allowed).toBe(true);
    expect((await service.consume('ip:route', 2)).allowed).toBe(false);
  });

  it('resets the bucket after the window expires', async () => {
    const service = createService();

    await service.consume('ip:route', 0);
    await service.consume('ip:route', 1);

    const result = await service.consume('ip:route', 1001);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
  });
});
