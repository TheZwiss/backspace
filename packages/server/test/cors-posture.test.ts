import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootTwoInstances, type TwoInstanceHarness } from './helpers/twoInstanceHarness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = path.resolve(__dirname, '../src');

describe('CORS posture', () => {
  let h: TwoInstanceHarness;

  beforeAll(async () => {
    h = await bootTwoInstances();
  }, 120_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  it('reflects an arbitrary browser origin, because client federation requires it', async () => {
    // A browser on instance A calls register/login on instance B before any
    // S2S peering exists. See instanceStore.connectToRemote.
    const res = await fetch(`${h.remote.origin}/api/instance/info`, {
      headers: { Origin: h.home.origin },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(h.home.origin);
  });

  it('reflects Origin: null so the desktop picker can probe from file://', async () => {
    const res = await fetch(`${h.remote.origin}/api/instance/info`, {
      headers: { Origin: 'null' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('null');
  });

  it('never grants credentialed cross-origin access', async () => {
    const res = await fetch(`${h.remote.origin}/api/instance/info`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('never grants credentialed access on a preflight either', async () => {
    const res = await fetch(`${h.remote.origin}/api/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('has no ambient-credential mechanism anywhere in the server', async () => {
    // The reason a reflected origin is safe here is that there is nothing for a
    // cross-origin page to ride on: no cookies, no HTTP auth, tokens live in
    // localStorage and are attached explicitly. If that ever stops being true,
    // the whole posture in docs/systems/web-security.md has to be revisited,
    // so fail loudly rather than let it drift.
    const { execSync } = await import('node:child_process');
    const hits = execSync(
      `grep -rniE "setcookie|@fastify/cookie|req(uest)?\\.cookies|['\\"]set-cookie['\\"]" ${SERVER_SRC} || true`,
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
    expect(hits).toEqual([]);
  });

  it('still declares the tus headers federated uploads need', async () => {
    const res = await fetch(`${h.remote.origin}/api/files/probe`, {
      method: 'OPTIONS',
      headers: {
        Origin: h.home.origin,
        'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'upload-offset,tus-resumable',
      },
    });
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    expect(allowed).toContain('upload-offset');
    expect(allowed).toContain('tus-resumable');
  });

  it('serves a source file that documents why the origin stays reflected', async () => {
    const src = await readFile(path.join(SERVER_SRC, 'index.ts'), 'utf8');
    expect(src).toMatch(/bearer/i);
    expect(src).not.toMatch(/credentials:\s*true/);
  });
});
