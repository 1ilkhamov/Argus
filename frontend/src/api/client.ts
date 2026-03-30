import { API_BASE } from '@/constants';

function getDefaultHeaders(): HeadersInit {
  const apiKey = import.meta.env.VITE_API_KEY;

  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { 'X-API-Key': apiKey } : {}),
  };
}

type ApiErrorResponse = {
  error?: { message?: string } | string;
  message?: string | string[];
};

function extractErrorMessage(body: unknown, fallback: string): string {
  if (typeof body === 'string' && body.trim()) {
    return body;
  }

  if (!body || typeof body !== 'object') {
    return fallback;
  }

  const typed = body as ApiErrorResponse;

  if (Array.isArray(typed.message) && typed.message.length > 0) {
    return typed.message.join(', ');
  }

  if (typeof typed.message === 'string' && typed.message) {
    return typed.message;
  }

  if (typeof typed.error === 'string' && typed.error) {
    return typed.error;
  }

  if (typed.error && typeof typed.error === 'object' && typeof typed.error.message === 'string') {
    return typed.error.message;
  }

  return fallback;
}

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T>(
  endpoint: string,
  options?: RequestInit,
): Promise<T> {
  const url = `${API_BASE}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      ...getDefaultHeaders(),
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    let body: unknown = raw;

    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }

    throw new ApiError(response.status, extractErrorMessage(body, `Request failed: ${response.statusText}`));
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

export async function apiStream(
  endpoint: string,
  body: unknown,
  onChunk: (data: unknown) => void,
  onDone: () => void,
  onError: (error: Error) => void,
): Promise<void> {
  const url = `${API_BASE}${endpoint}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: getDefaultHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      let body: unknown = raw;

      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }

      throw new ApiError(response.status, extractErrorMessage(body, `Stream failed: ${response.statusText}`));
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      const value = result.value;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            onChunk(data);
          } catch {
            // skip malformed JSON
          }
        }
      }
    }

    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data: ')) {
        try {
          const data = JSON.parse(trimmed.slice(6));
          onChunk(data);
        } catch {
          // skip malformed JSON
        }
      }
    }

    onDone();
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)));
  }
}
