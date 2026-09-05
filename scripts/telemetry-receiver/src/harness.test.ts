import { it, expect } from 'vitest';
import { env } from 'cloudflare:test';

it('has the pings table', async () => {
  const row = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pings'",
  ).first<{ name: string }>();
  expect(row?.name).toBe('pings');
});
