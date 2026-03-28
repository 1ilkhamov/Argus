import { Test } from '@nestjs/testing';

import { HttpRequestTool } from './http-request.tool';
import { ToolRegistryService } from '../../core/registry/tool-registry.service';

// ─── Mock fetch globally ─────────────────────────────────────────────────────

const mockFetch = jest.fn();
(global as unknown as Record<string, unknown>).fetch = mockFetch;

// Mock DNS lookup to allow all hostnames (we test SSRF logic separately)
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34' }]),
}));

function mockResponse(opts: {
  status?: number;
  statusText?: string;
  body?: string;
  headers?: Record<string, string>;
}): Response {
  const headers = new Headers(opts.headers ?? {});
  return {
    status: opts.status ?? 200,
    statusText: opts.statusText ?? 'OK',
    ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
    headers,
    text: jest.fn().mockResolvedValue(opts.body ?? ''),
  } as unknown as Response;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('HttpRequestTool', () => {
  let tool: HttpRequestTool;

  beforeEach(async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(mockResponse({ body: '{"ok":true}' }));

    const module = await Test.createTestingModule({
      providers: [
        HttpRequestTool,
        {
          provide: ToolRegistryService,
          useValue: { register: jest.fn() },
        },
      ],
    }).compile();

    tool = module.get(HttpRequestTool);
  });

  // ─── Definition ──────────────────────────────────────────────────────

  it('should have correct definition', () => {
    expect(tool.definition.name).toBe('http_request');
    expect(tool.definition.safety).toBe('moderate');
    expect(tool.definition.parameters.required).toEqual(['url']);
  });

  // ─── Input validation ────────────────────────────────────────────────

  it('should return error for empty url', async () => {
    const result = await tool.execute({ url: '' });
    expect(result).toContain('Error');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should return error for invalid url', async () => {
    const result = await tool.execute({ url: 'not-a-url' });
    expect(result).toContain('Error');
    expect(result).toContain('Invalid URL');
  });

  it('should return error for invalid method', async () => {
    const result = await tool.execute({ url: 'https://example.com', method: 'HACK' });
    expect(result).toContain('Error');
    expect(result).toContain('Invalid method');
  });

  it('should return error for body exceeding max length', async () => {
    const result = await tool.execute({
      url: 'https://example.com',
      method: 'POST',
      body: 'x'.repeat(50_001),
    });
    expect(result).toContain('Error');
    expect(result).toContain('too large');
  });

  // ─── SSRF protection ─────────────────────────────────────────────────

  it('should block localhost', async () => {
    const result = await tool.execute({ url: 'http://localhost/api' });
    expect(result).toContain('not allowed');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should block 127.0.0.1', async () => {
    const result = await tool.execute({ url: 'http://127.0.0.1/api' });
    expect(result).toContain('not allowed');
  });

  it('should block metadata endpoint', async () => {
    const result = await tool.execute({ url: 'http://169.254.169.254/latest/meta-data/' });
    expect(result).toContain('not allowed');
  });

  it('should block .internal suffix', async () => {
    const result = await tool.execute({ url: 'http://metadata.google.internal/v1/' });
    expect(result).toContain('not allowed');
  });

  it('should block embedded credentials', async () => {
    const result = await tool.execute({ url: 'https://user:pass@example.com/api' });
    expect(result).toContain('not allowed');
  });

  it('should block ftp protocol', async () => {
    const result = await tool.execute({ url: 'ftp://example.com/file' });
    expect(result).toContain('HTTP and HTTPS');
  });

  // ─── Successful requests ──────────────────────────────────────────────

  it('should make GET request by default', async () => {
    mockFetch.mockResolvedValue(mockResponse({ body: '{"data":"hello"}' }));

    const result = await tool.execute({ url: 'https://api.example.com/data' });

    expect(mockFetch).toHaveBeenCalled();
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[0]).toBe('https://api.example.com/data');
    expect(callArgs[1].method).toBe('GET');
    expect(result).toContain('HTTP 200');
    expect(result).toContain('{"data":"hello"}');
  });

  it('should make POST request with JSON body', async () => {
    mockFetch.mockResolvedValue(mockResponse({ status: 201, statusText: 'Created', body: '{"id":1}' }));

    const result = await tool.execute({
      url: 'https://api.example.com/items',
      method: 'POST',
      body: '{"name":"test"}',
    });

    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[1].method).toBe('POST');
    expect(callArgs[1].body).toBe('{"name":"test"}');
    expect(result).toContain('HTTP 201');
  });

  it('should auto-detect JSON content type', async () => {
    mockFetch.mockResolvedValue(mockResponse({ body: 'ok' }));

    await tool.execute({
      url: 'https://api.example.com/items',
      method: 'POST',
      body: '{"key":"value"}',
    });

    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('should set text/plain for non-JSON body', async () => {
    mockFetch.mockResolvedValue(mockResponse({ body: 'ok' }));

    await tool.execute({
      url: 'https://api.example.com/data',
      method: 'POST',
      body: 'hello world',
    });

    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get('Content-Type')).toBe('text/plain');
  });

  // ─── Bearer token ────────────────────────────────────────────────────

  it('should set Bearer token in Authorization header', async () => {
    mockFetch.mockResolvedValue(mockResponse({ body: '{}' }));

    await tool.execute({
      url: 'https://api.example.com/me',
      bearer_token: 'my-secret-token',
    });

    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer my-secret-token');
  });

  // ─── Custom headers ──────────────────────────────────────────────────

  it('should pass custom headers', async () => {
    mockFetch.mockResolvedValue(mockResponse({ body: '{}' }));

    await tool.execute({
      url: 'https://api.example.com/data',
      headers: { 'X-Custom': 'foo', Accept: 'text/xml' },
    });

    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get('X-Custom')).toBe('foo');
    expect(headers.get('Accept')).toBe('text/xml');
  });

  it('should block forbidden headers', async () => {
    mockFetch.mockResolvedValue(mockResponse({ body: '{}' }));

    await tool.execute({
      url: 'https://api.example.com/data',
      headers: { Host: 'evil.com', 'Transfer-Encoding': 'chunked', 'X-OK': 'fine' },
    });

    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.has('Host')).toBe(false);
    expect(headers.has('Transfer-Encoding')).toBe(false);
    expect(headers.get('X-OK')).toBe('fine');
  });

  // ─── Response formatting ─────────────────────────────────────────────

  it('should include status code and URL in output', async () => {
    mockFetch.mockResolvedValue(mockResponse({
      status: 404,
      statusText: 'Not Found',
      body: 'page not found',
    }));

    const result = await tool.execute({ url: 'https://api.example.com/missing' });
    expect(result).toContain('HTTP 404 Not Found');
    expect(result).toContain('https://api.example.com/missing');
    expect(result).toContain('page not found');
  });

  it('should truncate long responses', async () => {
    const longBody = 'x'.repeat(20_000);
    mockFetch.mockResolvedValue(mockResponse({ body: longBody }));

    const result = await tool.execute({ url: 'https://api.example.com/big' });
    expect(result).toContain('truncated');
    expect(result.length).toBeLessThan(longBody.length);
  });

  it('should handle 204 No Content', async () => {
    mockFetch.mockResolvedValue(mockResponse({ status: 204, statusText: 'No Content', body: '' }));

    const result = await tool.execute({ url: 'https://api.example.com/delete', method: 'DELETE' });
    expect(result).toContain('HTTP 204');
    expect(result).toContain('(no body)');
  });

  // ─── Error handling ──────────────────────────────────────────────────

  it('should handle network errors gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await tool.execute({ url: 'https://api.example.com/fail' });
    expect(result).toContain('Error');
    expect(result).toContain('ECONNREFUSED');
  });

  // ─── Redirects ───────────────────────────────────────────────────────

  it('should follow redirects by default', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse({
        status: 302,
        statusText: 'Found',
        headers: { location: 'https://api.example.com/new-location' },
      }))
      .mockResolvedValueOnce(mockResponse({ body: '{"redirected":true}' }));

    const result = await tool.execute({ url: 'https://api.example.com/old' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toContain('{"redirected":true}');
  });

  it('should not follow redirects when disabled', async () => {
    mockFetch.mockResolvedValue(mockResponse({
      status: 302,
      statusText: 'Found',
      headers: { location: 'https://api.example.com/new' },
    }));

    const result = await tool.execute({
      url: 'https://api.example.com/old',
      follow_redirects: false,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toContain('HTTP 302');
  });

  // ─── Method case insensitive ─────────────────────────────────────────

  it('should ignore body for GET requests (LLM may send empty body)', async () => {
    mockFetch.mockResolvedValue(mockResponse({ body: '{"ok":true}' }));

    const result = await tool.execute({
      url: 'https://api.example.com/data',
      method: 'GET',
      body: '',
    });

    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[1].body).toBeUndefined();
    expect(result).toContain('HTTP 200');
  });

  it('should ignore body for HEAD requests', async () => {
    mockFetch.mockResolvedValue(mockResponse({ status: 200 }));

    await tool.execute({
      url: 'https://api.example.com/data',
      method: 'HEAD',
      body: '{"ignored": true}',
    });

    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[1].body).toBeUndefined();
  });

  it('should accept lowercase method', async () => {
    mockFetch.mockResolvedValue(mockResponse({ body: '{}' }));

    await tool.execute({ url: 'https://api.example.com/data', method: 'post' });

    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[1].method).toBe('POST');
  });
});
