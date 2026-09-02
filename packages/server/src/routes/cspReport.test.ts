import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { cspReportRoutes } from './cspReport.js';

describe('POST /api/csp-report', () => {
  let app: FastifyInstance;
  let warned: unknown[][];

  beforeEach(async () => {
    warned = [];
    app = Fastify();
    app.log.warn = ((...args: unknown[]) => { warned.push(args); }) as never;
    await app.register(cspReportRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it('accepts the application/csp-report content type browsers actually send', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/csp-report',
      headers: { 'content-type': 'application/csp-report' },
      payload: JSON.stringify({
        'csp-report': {
          'document-uri': 'https://nova.example/app',
          'violated-directive': 'script-src',
          'blocked-uri': 'https://evil.example/x.js',
        },
      }),
    });
    expect(res.statusCode).toBe(204);
    expect(warned.length).toBe(1);
    expect(JSON.stringify(warned[0])).toContain('script-src');
  });

  it('accepts the Reporting API content type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/csp-report',
      headers: { 'content-type': 'application/reports+json' },
      payload: JSON.stringify([
        {
          type: 'csp-violation',
          url: 'https://nova.example/app',
          body: { effectiveDirective: 'worker-src', blockedURL: 'blob:https://nova.example/abc' },
        },
      ]),
    });
    expect(res.statusCode).toBe(204);
    expect(warned.length).toBe(1);
    expect(JSON.stringify(warned[0])).toContain('worker-src');
  });

  it('accepts plain application/json too', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/csp-report',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ 'csp-report': { 'violated-directive': 'img-src' } }),
    });
    expect(res.statusCode).toBe(204);
  });

  it('does not fall over on a malformed body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/csp-report',
      headers: { 'content-type': 'application/csp-report' },
      payload: 'this is not json',
    });
    expect(res.statusCode).toBe(204);
    expect(warned.length).toBe(1);
  });

  it('truncates an oversized report instead of logging it whole', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/csp-report',
      headers: { 'content-type': 'application/csp-report' },
      payload: JSON.stringify({
        'csp-report': { 'blocked-uri': `https://evil.example/${'a'.repeat(20_000)}` },
      }),
    });
    expect(res.statusCode).toBe(204);
    const logged = JSON.stringify(warned[0]);
    expect(logged.length).toBeLessThan(6_000);
  });

  it('requires no authentication, because a violation can happen pre-login', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/csp-report',
      headers: { 'content-type': 'application/csp-report' },
      payload: JSON.stringify({ 'csp-report': {} }),
    });
    expect(res.statusCode).toBe(204);
  });
});
