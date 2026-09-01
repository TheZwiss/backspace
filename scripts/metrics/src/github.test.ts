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

  it('sleeps between retries but skips the sleep after the final attempt', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, { status: 202 }));
    const sleep = vi.fn(async () => {});
    const client = createClient('t', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      statsAttempts: 4,
    });
    const result = await client.getStats('/stats/contributors');
    expect(result).toBeNull();
    // 4 attempts means 3 gaps between them; the 4th (final) attempt must not
    // sleep afterward, since nothing will read the result of that sleep.
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[2000], [4000], [6000]]);
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

  it('throws and names the URL when a page body is an object instead of an array', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ not: 'an array' }));
    const client = createClient('t', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await expect(client.paginate('/x')).rejects.toThrow(
      'https://api.github.com/x?per_page=100',
    );
  });

  it('throws and names the URL when a page body is a string instead of an array', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('not an array'));
    const client = createClient('t', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await expect(client.paginate('/y')).rejects.toThrow(
      'https://api.github.com/y?per_page=100',
    );
  });

  it('aborts and does not return partial results when a later page is non-2xx', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ id: 1 }], {
          headers: { link: '<https://api.github.com/x?page=2>; rel="next"' },
        }),
      )
      .mockResolvedValueOnce(new Response('server error', { status: 500 }));
    const client = createClient('t', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    let result: unknown;
    let error: unknown;
    try {
      result = await client.paginate('/x');
    } catch (caught) {
      error = caught;
    }
    expect(result).toBeUndefined();
    expect(error).toBeInstanceOf(GitHubError);
    expect(error).toMatchObject({ status: 500 });
  });

  it('throws a descriptive error naming the URL when rel=next cycles back to an earlier page', async () => {
    const page1 = (): Response =>
      jsonResponse([{ id: 1 }], {
        headers: { link: '<https://api.github.com/x?page=2>; rel="next"' },
      });
    const page2 = (): Response =>
      jsonResponse([{ id: 2 }], {
        // Points back at the very first URL this call fetched, forming a cycle.
        headers: { link: '<https://api.github.com/x?per_page=100>; rel="next"' },
      });
    // Hard ceiling inside the mock itself. Without the cycle guard this loop
    // is a tight microtask cycle that never yields to a macrotask, so it
    // exhausts memory and crashes the worker BEFORE vitest's timeout can fire
    // — an opaque CI crash instead of a red test. Throwing here makes a future
    // regression fail fast and legibly.
    let calls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      calls += 1;
      if (calls > 4) throw new Error('cycle guard regressed: paginate kept fetching');
      return url.includes('page=2') ? page2() : page1();
    });
    const client = createClient('t', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await expect(client.paginate('/x')).rejects.toThrow(
      'https://api.github.com/x?per_page=100',
    );
    // The cycle must be caught before re-fetching the repeated URL a third
    // time — otherwise this test would hang instead of asserting anything.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }, 2000);

  it('refuses to follow a rel="next" URL whose origin is not the GitHub API, rather than sending the bearer token there', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([{ id: 1 }], {
        headers: { link: '<https://evil.example.com/steal>; rel="next"' },
      }),
    );
    const client = createClient('t', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await expect(client.paginate('/x')).rejects.toThrow('https://evil.example.com/steal');
    // Exactly one fetch: the malicious next-URL must never be requested.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('unparseable 2xx response bodies', () => {
  it('wraps a 204 empty body in a GitHubError carrying the status and the parse failure as cause', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createClient('t', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    let error: unknown;
    try {
      await client.get('/x');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GitHubError);
    expect(error).toMatchObject({ status: 204 });
    expect((error as GitHubError).cause).toBeInstanceOf(Error);
  });

  it('wraps a 200 with a non-JSON body in a GitHubError carrying the status', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 }));
    const client = createClient('t', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    let error: unknown;
    try {
      await client.get('/x');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GitHubError);
    expect(error).toMatchObject({ status: 200 });
    expect((error as GitHubError).cause).toBeInstanceOf(Error);
  });

  it('wraps an unparseable getStats success body in a GitHubError', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 }));
    const client = createClient('t', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await expect(client.getStats('/stats/contributors')).rejects.toBeInstanceOf(GitHubError);
  });

  it('wraps an unparseable paginate page body in a GitHubError', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 }));
    const client = createClient('t', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await expect(client.paginate('/x')).rejects.toBeInstanceOf(GitHubError);
  });
});
