import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApiClient, HttpError, RateLimitError } from './client';
import { describeError } from '../i18n/errors';

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

  it('keeps the server\'s own 429 code so its catalog text is reachable', async () => {
    answer(429, JSON.stringify({ error: 'Too many lookups', code: 'lookup_rate_limited', statusCode: 429, retryAfter: 60 }), {
      'content-type': 'application/json',
    });
    const err = (await thrownBy(() => client.users.me())) as RateLimitError;
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.code).toBe('lookup_rate_limited');
    expect(err.retryAfter).toBe(60);
    expect(describeError(err)).toBe('Too many lookups. Try again in a minute.');
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

describe('history after a cursor', () => {
  const client = createApiClient('https://home.test', () => null);

  it('sends the cursor and reports a page the server cut after it', async () => {
    answer(200, JSON.stringify([{ id: '11' }, { id: '12' }]), { 'x-backspace-paging': 'after' });
    const page = await client.channels.messagesAfter('chan-1', '10', 50);
    expect(page).toEqual({ messages: [{ id: '11' }, { id: '12' }], forward: true });
    const url = String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(url).toBe('https://home.test/api/channels/chan-1/messages?after=10&limit=50');
  });

  it('reports the newest page of a server that ignored the cursor', async () => {
    answer(200, JSON.stringify([{ id: '90' }]));
    const page = await client.dm.messagesAfter('dm-1', '10', 50);
    expect(page).toEqual({ messages: [{ id: '90' }], forward: false });
    const url = String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(url).toBe('https://home.test/api/dm/dm-1/messages?after=10&limit=50');
  });
});
