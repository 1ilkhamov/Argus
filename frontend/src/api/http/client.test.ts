import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apiFetch, apiStream, ApiError } from './client';

const createMockResponse = (options: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  json?: unknown;
  text?: string;
  body?: ReadableStream<Uint8Array> | null;
}): Response => {
  const {
    ok = true,
    status = 200,
    statusText = 'OK',
    json,
    text = '',
    body = null,
  } = options;

  return {
    ok,
    status,
    statusText,
    headers: new Headers(),
    redirected: false,
    type: 'basic',
    url: '',
    body,
    bodyUsed: false,
    clone: () => createMockResponse(options),
    json: async () => json,
    text: async () => text,
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
    bytes: async () => new Uint8Array(),
  } as Response;
};

function createSseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const raw = events.map((e) => `data: ${e}\n\n`).join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(raw));
      controller.close();
    },
  });
}

describe('apiFetch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed JSON on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createMockResponse({ json: { ok: true } }),
    );

    const result = await apiFetch<{ ok: boolean }>('/test');
    expect(result).toEqual({ ok: true });
  });

  it('returns undefined for 204 No Content', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createMockResponse({ status: 204 }),
    );

    const result = await apiFetch('/test');
    expect(result).toBeUndefined();
  });

  it('throws ApiError with message from error.message field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createMockResponse({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: JSON.stringify({ error: { message: 'Invalid API key' } }),
      }),
    );

    await expect(apiFetch('/test')).rejects.toThrow(ApiError);
    await expect(apiFetch('/test')).rejects.toThrow('Invalid API key');
  });

  it('throws ApiError with message from string error field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createMockResponse({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: JSON.stringify({ error: 'Something broke' }),
      }),
    );

    await expect(apiFetch('/test')).rejects.toThrow('Something broke');
  });

  it('throws ApiError with message array joined', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createMockResponse({
        ok: false,
        status: 400,
        text: JSON.stringify({ message: ['field1 required', 'field2 invalid'] }),
      }),
    );

    await expect(apiFetch('/test')).rejects.toThrow('field1 required, field2 invalid');
  });

  it('throws ApiError with fallback on unparseable body', async () => {
    const mockResponse = createMockResponse({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      text: '<html>502</html>',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);

    await expect(apiFetch('/test')).rejects.toThrow('<html>502</html>');
  });

  it('sends Content-Type application/json header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createMockResponse({ json: {} }),
    );

    await apiFetch('/test');

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('includes browser credentials for cookie-based auth', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createMockResponse({ json: {} }),
    );

    await apiFetch('/test');

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.credentials).toBe('include');
  });
});

describe('apiStream', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('parses SSE tokens and calls onChunk for each event', async () => {
    const events = [
      JSON.stringify({ event: 'token', data: 'Hello' }),
      JSON.stringify({ event: 'token', data: ' world' }),
      JSON.stringify({ event: 'done', data: '', conversationId: 'c1', messageId: 'm1' }),
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createMockResponse({ body: createSseStream(events) }),
    );

    const chunks: unknown[] = [];
    await apiStream(
      '/chat/messages/stream',
      { content: 'hi' },
      (data) => chunks.push(data),
      () => {},
      () => {},
    );

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ event: 'token', data: 'Hello' });
    expect(chunks[1]).toEqual({ event: 'token', data: ' world' });
    expect(chunks[2]).toEqual({ event: 'done', data: '', conversationId: 'c1', messageId: 'm1' });
  });

  it('includes browser credentials for streaming requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createMockResponse({ body: createSseStream([JSON.stringify({ event: 'done', data: '' })]) }),
    );

    await apiStream('/stream', { content: 'hi' }, () => {}, () => {}, () => {});

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.credentials).toBe('include');
  });

  it('calls onDone when stream completes normally', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createMockResponse({
        body: createSseStream([JSON.stringify({ event: 'done', data: '' })]),
      }),
    );

    const doneFn = vi.fn();
    await apiStream('/stream', { content: 'hi' }, () => {}, doneFn, () => {});
    expect(doneFn).toHaveBeenCalledTimes(1);
  });

  it('calls onError on non-ok response and parses error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createMockResponse({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        text: JSON.stringify({ message: 'Rate limit exceeded' }),
      }),
    );

    const errorFn = vi.fn();
    await apiStream('/stream', { content: 'hi' }, () => {}, () => {}, errorFn);

    expect(errorFn).toHaveBeenCalledTimes(1);
    const err = errorFn.mock.calls[0]?.[0] as Error;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('Rate limit exceeded');
    expect((err as ApiError).statusCode).toBe(429);
  });

  it('calls onError on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

    const errorFn = vi.fn();
    await apiStream('/stream', { content: 'hi' }, () => {}, () => {}, errorFn);

    expect(errorFn).toHaveBeenCalledTimes(1);
    expect(errorFn.mock.calls[0]?.[0]).toBeInstanceOf(TypeError);
  });

  it('calls onError when response has no body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createMockResponse({ body: null }),
    );

    const errorFn = vi.fn();
    await apiStream('/stream', { content: 'hi' }, () => {}, () => {}, errorFn);

    expect(errorFn).toHaveBeenCalledTimes(1);
    expect(errorFn.mock.calls[0]?.[0].message).toBe('No response body');
  });

  it('skips malformed SSE lines gracefully', async () => {
    const encoder = new TextEncoder();
    const raw = `data: {"event":"token","data":"ok"}\n\ndata: not json\n\ndata: {"event":"done","data":""}\n\n`;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(raw));
        controller.close();
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createMockResponse({ body: stream }),
    );

    const chunks: unknown[] = [];
    await apiStream('/stream', { content: 'hi' }, (data) => chunks.push(data), () => {}, () => {});

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ event: 'token', data: 'ok' });
    expect(chunks[1]).toEqual({ event: 'done', data: '' });
  });

  it('handles chunked SSE delivery across multiple reads', async () => {
    const encoder = new TextEncoder();
    const part1 = 'data: {"event":"to';
    const part2 = 'ken","data":"Hi"}\n\ndata: {"event":"done","data":""}\n\n';

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(part1));
        controller.enqueue(encoder.encode(part2));
        controller.close();
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createMockResponse({ body: stream }),
    );

    const chunks: unknown[] = [];
    await apiStream('/stream', { content: 'hi' }, (data) => chunks.push(data), () => {}, () => {});

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ event: 'token', data: 'Hi' });
  });
});
