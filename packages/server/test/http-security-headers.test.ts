import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  bootTwoInstances,
  bootTwoInstancesWithRateLimits,
  type TwoInstanceHarness,
} from './helpers/twoInstanceHarness.js';

/** Split a CSP header value into directive name -> source list. */
function parsePolicy(header: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const segment of header.split(';')) {
    const parts = segment.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    out[parts[0]!] = parts.slice(1);
  }
  return out;
}

/**
 * A one-byte PNG signature. Enough for the file-serving route: it reads the
 * mimetype from the extension when no attachment row matches, and streams
 * whatever bytes are on disk.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Name of the fixture served to exercise the route-level policy override. */
const SERVED_FIXTURE = 'security-headers-fixture.png';

describe('HTTP security headers, LiveKit unconfigured', () => {
  let h: TwoInstanceHarness;
  let uploadDir: string;
  let previousUploadDir: string | undefined;

  beforeAll(async () => {
    // twoInstanceHarness passes STORAGE_PATH, which config.ts does not read, so
    // a spawned instance otherwise falls back to the repo's own data/uploads.
    // Point UPLOAD_DIR at a scratch directory before spawning: the child
    // inherits process.env, so the fixture written below is the file the
    // instance serves, and nothing lands in the working tree.
    previousUploadDir = process.env.UPLOAD_DIR;
    uploadDir = await mkdtemp(path.join(os.tmpdir(), 'backspace-headers-'));
    await mkdir(uploadDir, { recursive: true });
    await writeFile(path.join(uploadDir, SERVED_FIXTURE), PNG_SIGNATURE);
    process.env.UPLOAD_DIR = uploadDir;
    h = await bootTwoInstances();
  }, 120_000);

  afterAll(async () => {
    await h?.cleanup();
    if (previousUploadDir === undefined) {
      delete process.env.UPLOAD_DIR;
    } else {
      process.env.UPLOAD_DIR = previousUploadDir;
    }
    await rm(uploadDir, { recursive: true, force: true });
  });

  it('ships the policy report-only, so nothing is blocked yet', async () => {
    const res = await fetch(`${h.home.origin}/api/instance/info`);
    expect(res.headers.get('content-security-policy-report-only')).toBeTruthy();
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('carries the directives that stop injection and framing', async () => {
    const res = await fetch(`${h.home.origin}/api/instance/info`);
    const p = parsePolicy(res.headers.get('content-security-policy-report-only') ?? '');
    expect(p['object-src']).toEqual(["'none'"]);
    expect(p['frame-ancestors']).toEqual(["'none'"]);
    expect(p['base-uri']).toEqual(["'self'"]);
    expect(p['script-src']).not.toContain("'unsafe-inline'");
    expect(p['worker-src']).toContain('blob:');
  });

  it('names no LiveKit origin when voice is off', async () => {
    const res = await fetch(`${h.home.origin}/api/instance/info`);
    const header = res.headers.get('content-security-policy-report-only') ?? '';
    expect(header).not.toContain('livekit.test.local');
  });

  it('declares the reporting endpoint group', async () => {
    const res = await fetch(`${h.home.origin}/api/instance/info`);
    expect(res.headers.get('reporting-endpoints') ?? '').toContain('/api/csp-report');
  });

  it('sets nosniff and a referrer policy', async () => {
    const res = await fetch(`${h.home.origin}/api/instance/info`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBeTruthy();
  });

  it('leaves HSTS to the TLS terminator', async () => {
    // Caddy owns Strict-Transport-Security because only the terminator knows
    // TLS is actually in play. Emitting it from the app would be wrong on a
    // plain-HTTP LAN deployment and would double up behind Caddy.
    const res = await fetch(`${h.home.origin}/api/instance/info`);
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });

  it('allows cross-origin resource loading, which federation depends on', async () => {
    // Peers load avatars and attachments from each other with plain <img>.
    // helmet's default Cross-Origin-Resource-Policy of same-origin would
    // block every one of them.
    const res = await fetch(`${h.home.origin}/api/instance/info`);
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });

  it('does not override a route that already set its own stricter policy', async () => {
    // routes/uploads.ts serves user files under a `default-src 'none'` sandbox.
    // That policy is stricter than the app policy and must survive, and the
    // permissive report-only header must not be attached alongside it.
    //
    // The request has to hit a file that exists. A missing filename returns 404
    // from before the header is set, so asking for one would assert nothing.
    const res = await fetch(`${h.home.origin}/api/uploads/${SERVED_FIXTURE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('content-security-policy-report-only')).toBeNull();
  });

  it('still applies the app policy to a response the file route rejects', async () => {
    // The counterpart to the test above: the 404 path never reaches the header
    // the file route sets, so the hook must fill it in like any other response.
    const res = await fetch(`${h.home.origin}/api/uploads/does-not-exist.png`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('content-security-policy-report-only')).toContain("object-src 'none'");
  });

  it('accepts a violation report over the wire', async () => {
    const res = await fetch(`${h.home.origin}/api/csp-report`, {
      method: 'POST',
      headers: { 'content-type': 'application/csp-report' },
      body: JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src' } }),
    });
    expect(res.status).toBe(204);
  });
});

describe('HTTP security headers, LiveKit configured', () => {
  let h: TwoInstanceHarness;

  beforeAll(async () => {
    h = await bootTwoInstances({ enableLiveKit: true });
  }, 120_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  it('names the configured LiveKit origin in connect-src', async () => {
    const res = await fetch(`${h.home.origin}/api/instance/info`);
    const p = parsePolicy(res.headers.get('content-security-policy-report-only') ?? '');
    expect(p['connect-src']).toContain('wss://livekit.test.local');
  });
});

describe('the violation sink sits behind the rate limiter', () => {
  let h: TwoInstanceHarness;

  beforeAll(async () => {
    h = await bootTwoInstancesWithRateLimits();
  }, 120_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  it('stops answering a flood of reports from one address', async () => {
    // The sink is unauthenticated and writes a log line per report, so it has
    // to be covered by the limiter. @fastify/rate-limit only guards routes
    // registered after it, which makes this purely a question of registration
    // order in index.ts and invisible in the source of the route itself.
    const limit = 200;
    const statuses: number[] = [];
    for (let i = 0; i < limit + 40; i++) {
      const res = await fetch(`${h.home.origin}/api/csp-report`, {
        method: 'POST',
        headers: { 'content-type': 'application/csp-report' },
        body: JSON.stringify({ 'csp-report': { 'violated-directive': 'img-src' } }),
      });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 204).length).toBeGreaterThan(0);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  }, 60_000);
});
