import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApiClient, HttpError, RateLimitError } from './client';

const originalFetch = globalThis.fetch;

function answer(status: number, body: string | null, headers: Record<string, string> = {}): void {
  (globalThis.fetch as unknown) = vi.fn().mockResolvedValue(new Response(body, { status, headers }));
}

async function thrownBy(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error('the request did not throw');
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('a 429 answer', () => {
  const client = createApiClient('https://home.test', () => null);

  it('is a RateLimitError that is also an HttpError carrying the rate_limited code', async () => {
    answer(429, JSON.stringify({ error: 'Too many requests', code: 'rate_limited', statusCode: 429, retryAfter: 17 }), {
      'content-type': 'application/json',
      'retry-after': '17',
    });
    const err = await thrownBy(() => client.users.me());
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err).toBeInstanceOf(HttpError);
    const limited = err as RateLimitError;
    expect(limited.name).toBe('RateLimitError');
    expect(limited.status).toBe(429);
    expect(limited.code).toBe('rate_limited');
    expect(limited.retryAfter).toBe(17);
    expect(limited.message).toBe('Too many requests');
  });

  it('keeps details from the body when there are any', async () => {
    answer(429, JSON.stringify({ error: 'Too many requests', code: 'rate_limited', statusCode: 429, retryAfter: 5, details: { max: 200 } }));
    const err = (await thrownBy(() => client.users.me())) as RateLimitError;
    expect(err.details).toEqual({ max: 200 });
  });

  it('with an empty body still reads retryAfter from the header', async () => {
    answer(429, null, { 'retry-after': '42' });
    const err = (await thrownBy(() => client.users.me())) as RateLimitError;
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.code).toBe('rate_limited');
    expect(err.retryAfter).toBe(42);
  });

  it('with neither body nor header falls back to sixty seconds', async () => {
    answer(429, null);
    const err = (await thrownBy(() => client.users.me())) as RateLimitError;
    expect(err.retryAfter).toBe(60);
  });
});
