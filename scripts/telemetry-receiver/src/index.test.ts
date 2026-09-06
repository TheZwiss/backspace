import { describe, it, expect, beforeEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import type { Env } from './env';
import worker from './index';

const ID = '3f6c9e2a-1b2c-4d5e-8f90-1234567890ab';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function ping(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema: 1, instance: ID, day: today(), users: { registered: 5 }, ...over });
}

async function call(req: Request, e: Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/**
 * Every ping built by `post()` gets its own source address.
 *
 * The rate-limit binding miniflare builds from `wrangler.toml` is the live one,
 * 10 requests per 10 seconds. Without a `cf-connecting-ip` header the Worker
 * keys every request as `unknown`, so the whole file shared one bucket and the
 * suite sat exactly on the budget: the next ping test anyone added would have
 * got a 429 from a limiter the test was not about. Addresses come from
 * 203.0.113.0/24, the TEST-NET-3 documentation range.
 */
let nextAddress = 0;

function post(body: string, cf: Record<string, unknown> = { country: 'DE' }): Request {
  nextAddress += 1;
  return new Request('https://hello.test/v1/ping', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${nextAddress}` },
    body,
    cf,
  } as RequestInit);
}

interface Row { instance: string; day: string; received_at: string; country: string; schema: number; body: string }

async function rows(): Promise<Row[]> {
  const { results } = await env.DB.prepare(
    'SELECT instance, day, received_at, country, schema, body FROM pings ORDER BY day',
  ).all<Row>();
  return results;
}

/**
 * Reads a response body as text without `Response.text()`.
 *
 * workerd logs a warning whenever `.text()` is called on a body whose content
 * type is not one it recognises as text, and `application/x-ndjson` is not on
 * that list. The bytes are plain UTF-8 either way, and the collector reads the
 * same body with `text()` under Node, where the decoding is identical.
 */
async function readText(res: Response): Promise<string> {
  return new TextDecoder().decode(await res.arrayBuffer());
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM pings').run();
});

describe('POST /v1/ping', () => {
  it('stores a row with the edge country and answers 204', async () => {
    const res = await call(post(ping()));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ instance: ID, day: today(), country: 'DE', schema: 1 });
    expect(all[0]!.received_at.startsWith(today())).toBe(true);
  });

  it('rounds the stored counts to two significant digits', async () => {
    await call(post(ping({ users: { registered: 12345 } })));
    const all = await rows();
    expect(JSON.parse(all[0]!.body).users.registered).toBe(12000);
  });

  it('upserts on instance and day', async () => {
    await call(post(ping({ users: { registered: 5 } })));
    await call(post(ping({ users: { registered: 6 } })));
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(JSON.parse(all[0]!.body).users.registered).toBe(6);
  });

  it('answers 400 to an invalid body and to an oversized body without a length header', async () => {
    expect((await call(post('{'))).status).toBe(400);
    expect((await call(post(ping({ pad: 'x'.repeat(5000) })))).status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  it('stores ZZ when the edge has no country', async () => {
    await call(post(ping(), {}));
    expect((await rows())[0]!.country).toBe('ZZ');
  });

  it('answers 410 when retired', async () => {
    const res = await call(post(ping()), { ...env, RETIRED: '1' });
    expect(res.status).toBe(410);
    expect(await rows()).toHaveLength(0);
  });

  it('answers 429 when the limiter says no', async () => {
    const limiter = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    const res = await call(post(ping()), { ...env, RATE_LIMITER: limiter });
    expect(res.status).toBe(429);
    expect(await rows()).toHaveLength(0);
  });

  it('keys the limiter on the connecting address and stores nothing of it', async () => {
    const keys: string[] = [];
    const limiter = {
      limit: async (options: { key: string }) => {
        keys.push(options.key);
        return { success: true };
      },
    } as unknown as RateLimit;
    // The one test that asserts on the key pins its own, high enough that the
    // per-call counter above never reaches it.
    const req = post(ping());
    req.headers.set('cf-connecting-ip', '203.0.113.200');
    const res = await call(req, { ...env, RATE_LIMITER: limiter });
    expect(res.status).toBe(204);
    expect(keys).toEqual(['203.0.113.200']);
    const stored = await rows();
    expect(JSON.stringify(stored)).not.toContain('203.0.113.200');
  });
});

describe('GET /v1/export', () => {
  it('requires the bearer token and returns NDJSON for a range', async () => {
    await call(post(ping()));
    const d = today();
    let res = await call(new Request(`https://hello.test/v1/export?from=${d}&to=${d}`));
    expect(res.status).toBe(401);
    res = await call(new Request(`https://hello.test/v1/export?from=${d}&to=${d}`, {
      headers: { authorization: 'Bearer wrong' },
    }));
    expect(res.status).toBe(401);
    res = await call(new Request(`https://hello.test/v1/export?from=${d}&to=${d}`, {
      headers: { authorization: 'Bearer test-export-token' },
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = (await readText(res)).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ instance: ID, day: d, country: 'DE', schema: 1 });
  });

  it('emits the envelope the collector parses, with body as a JSON string', async () => {
    await call(post(ping()));
    const d = today();
    const res = await call(new Request(`https://hello.test/v1/export?from=${d}&to=${d}`, {
      headers: { authorization: 'Bearer test-export-token' },
    }));
    const row = JSON.parse((await readText(res)).trim()) as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(['body', 'country', 'day', 'instance', 'receivedAt', 'schema']);
    expect(typeof row['body']).toBe('string');
    expect(JSON.parse(row['body'] as string)).toMatchObject({ schema: 1, instance: ID });
    expect(typeof row['receivedAt']).toBe('string');
  });

  it('rejects every export when no token is configured', async () => {
    const d = today();
    const res = await call(new Request(`https://hello.test/v1/export?from=${d}&to=${d}`, {
      headers: { authorization: 'Bearer test-export-token' },
    }), { ...env, EXPORT_TOKEN: '' });
    expect(res.status).toBe(401);
  });

  it('returns an empty body for a range with no rows', async () => {
    const res = await call(new Request('https://hello.test/v1/export?from=2026-01-01&to=2026-01-05', {
      headers: { authorization: 'Bearer test-export-token' },
    }));
    expect(res.status).toBe(200);
    expect(await readText(res)).toBe('');
  });

  it('rejects bad or too-long ranges', async () => {
    const h = { headers: { authorization: 'Bearer test-export-token' } };
    expect((await call(new Request('https://hello.test/v1/export?from=x&to=y', h))).status).toBe(400);
    expect((await call(new Request('https://hello.test/v1/export?from=2026-01-01&to=2026-03-01', h))).status).toBe(400);
    expect((await call(new Request('https://hello.test/v1/export?from=2026-02-01&to=2026-01-01', h))).status).toBe(400);
    expect((await call(new Request('https://hello.test/v1/export', h))).status).toBe(400);
  });

  it('accepts a range of exactly 31 days', async () => {
    const h = { headers: { authorization: 'Bearer test-export-token' } };
    expect((await call(new Request('https://hello.test/v1/export?from=2026-01-01&to=2026-01-31', h))).status).toBe(200);
    expect((await call(new Request('https://hello.test/v1/export?from=2026-01-01&to=2026-02-01', h))).status).toBe(400);
  });

  it('rejects a range whose ends are not real calendar days', async () => {
    const h = { headers: { authorization: 'Bearer test-export-token' } };
    // `Date.parse` rolls 2026-02-30 into March, so the shape check passed and
    // the 31-day span was measured from a day that does not exist, widening
    // the window by up to three days.
    expect((await call(new Request('https://hello.test/v1/export?from=2026-02-30&to=2026-03-05', h))).status).toBe(400);
    expect((await call(new Request('https://hello.test/v1/export?from=2026-02-01&to=2026-02-30', h))).status).toBe(400);
    expect((await call(new Request('https://hello.test/v1/export?from=2026-13-01&to=2026-13-02', h))).status).toBe(400);
    // A real range still passes, including a leap day.
    expect((await call(new Request('https://hello.test/v1/export?from=2028-02-28&to=2028-02-29', h))).status).toBe(200);
  });

  it('truncates at the row cap and says so, keeping the earliest rows', async () => {
    const OVER = 10_001;
    const stmt = env.DB.prepare(
      'INSERT INTO pings (instance, day, received_at, country, schema, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    );
    // One instance per row, spread over the range, so the day-then-instance
    // ordering has something to order.
    await env.DB.batch(
      Array.from({ length: OVER }, (_, i) =>
        stmt.bind(
          `${String(i).padStart(8, '0')}-1b2c-4d5e-8f90-1234567890ab`,
          `2026-01-${String((i % 31) + 1).padStart(2, '0')}`,
          '2026-01-31T00:00:00.000Z',
          'DE',
          1,
          '{"schema":1}',
        ),
      ),
    );

    const res = await call(new Request('https://hello.test/v1/export?from=2026-01-01&to=2026-01-31', {
      headers: { authorization: 'Bearer test-export-token' },
    }));

    expect(res.status).toBe(200);
    expect(res.headers.get('x-export-truncated')).toBe('1');
    const lines = (await readText(res)).trim().split('\n');
    expect(lines).toHaveLength(10_000);
    // Ordered by day then instance, so the cap always drops the same tail.
    const days = lines.map((l) => (JSON.parse(l) as { day: string }).day);
    expect(days[0]).toBe('2026-01-01');
    expect([...days]).toEqual([...days].sort());
  });

  it('does not claim truncation on a range that fits', async () => {
    await call(post(ping()));
    const d = today();
    const res = await call(new Request(`https://hello.test/v1/export?from=${d}&to=${d}`, {
      headers: { authorization: 'Bearer test-export-token' },
    }));
    expect(res.headers.get('x-export-truncated')).toBeNull();
  });
});

describe('other routes', () => {
  it('serves the root page and 404s elsewhere', async () => {
    const root = await call(new Request('https://hello.test/'));
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(root.headers.get('x-content-type-options')).toBe('nosniff');
    expect(root.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await root.text();
    expect(html).toContain('docs/systems/telemetry.md');
    // Nothing on the page may reach off the host: the policy above forbids it
    // and the page must not need it.
    expect(html).not.toMatch(/<(script|link|img)\b/);
    expect((await call(new Request('https://hello.test/nope'))).status).toBe(404);
    expect((await call(new Request('https://hello.test/v1/ping'))).status).toBe(404);
  });
});

describe('scheduled', () => {
  it('deletes rows older than 90 days', async () => {
    await env.DB.prepare(
      "INSERT INTO pings (instance, day, received_at, country, schema, body) VALUES (?, '2020-01-01', 'x', 'ZZ', 1, '{}')",
    ).bind(ID).run();
    await call(post(ping()));
    const ctx = createExecutionContext();
    await worker.scheduled({ scheduledTime: Date.now(), cron: '', noRetry() {} } as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.day).toBe(today());
  });
});
