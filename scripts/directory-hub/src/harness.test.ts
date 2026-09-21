import { it, expect } from 'vitest';
import { env } from 'cloudflare:test';

it('has the four directory tables', async () => {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('origins', 'fetch_attempts', 'spaces', 'blocks') ORDER BY name",
  ).all<{ name: string }>();
  expect(results.map((row) => row.name)).toEqual(['blocks', 'fetch_attempts', 'origins', 'spaces']);
});
