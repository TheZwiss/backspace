import { describe, it, expect, vi } from 'vitest';
import { createClient, GitHubError } from './github.ts';

const noSleep = async (): Promise<void> => {};

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('createClient.get', () => {
  it('sends the token and the API version header', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const client = createClient('tok_123', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await client.get('/repos/o/r');
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://api.github.com/repos/o/r');
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok_123');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  it('honours a custom Accept header for the star media type', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const client = createClient('t', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await client.get('/stargazers', 'application/vnd.github.star+json');
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Accept).toBe('application/vnd.github.star+json');
  });

  it('throws GitHubError carrying the status on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'Not Found' }, { status: 404 }));
    const client = createClient('t', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await expect(client.get('/nope')).rejects.toBeInstanceOf(GitHubError);
    await expect(client.get('/nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('createClient.getStats', () => {
  it('retries a 202 and returns the body once it becomes 200', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse([{ total: 5 }]));
    const client = createClient('t', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await expect(client.getStats('/stats/contributors')).resolves.toEqual([{ total: 5 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns null after a persistent 202 rather than an empty body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, { status: 202 }));
    const client = createClient('t', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
      statsAttempts: 3,
    });
    const result = await client.getStats('/stats/contributors');
    expect(result).toBeNull();
    expect(result).not.toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('createClient.paginate', () => {
  it('follows rel=next until it is absent and concatenates pages', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ id: 1 }], {
          headers: { link: '<https://api.github.com/x?page=2>; rel="next"' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse([{ id: 2 }]));
    const client = createClient('t', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await expect(client.paginate('/x')).resolves.toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('requests 100 items per page', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const client = createClient('t', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await client.paginate('/x');
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain('per_page=100');
  });
});
