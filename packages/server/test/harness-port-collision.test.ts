import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exitedOnPortCollision } from './helpers/twoInstanceHarness';

/**
 * The harness retries a spawn that lost a port race, and only that.
 *
 * A spawned instance exits 1 for every fatal boot error, so the exit code
 * cannot tell a lost race from a real failure — the decision is made by reading
 * the boot log. This covers that decision, because getting it wrong in the
 * permissive direction would turn one clear error into five identical ones.
 */
describe('harness port-collision detection', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'harness-port-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const withLog = async (name: string, contents: string): Promise<string> => {
    const file = path.join(dir, name);
    await writeFile(file, contents);
    return file;
  };

  it('retries when the boot log shows the port was taken', async () => {
    const log = await withLog('collision.log', [
      'Error: listen EADDRINUSE: address already in use 127.0.0.1:40891',
      '    at Server.setupListenHandle [as _listen2] (node:net:1817:16)',
    ].join('\n'));
    expect(await exitedOnPortCollision(log)).toBe(true);
  });

  it('does not retry a genuine boot failure', async () => {
    const log = await withLog('real-failure.log', [
      'JWT_SECRET must be at least 32 characters',
      'Error: connect ECONNREFUSED 127.0.0.1:5432',
      'SqliteError: no such table: users',
    ].join('\n'));
    expect(await exitedOnPortCollision(log)).toBe(false);
  });

  it('does not retry when the boot produced no log at all', async () => {
    // No evidence of a collision is not evidence of one: an unreadable or
    // missing log must surface the original failure rather than spend retries.
    expect(await exitedOnPortCollision(path.join(dir, 'does-not-exist.log'))).toBe(false);
  });

  it('does not retry an empty log', async () => {
    const log = await withLog('empty.log', '');
    expect(await exitedOnPortCollision(log)).toBe(false);
  });
});
