import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
const mocks = vi.hoisted(() => ({ config: { ttsUrl: 'http://127.0.0.1:5052' as string | undefined }, fetch: vi.fn() }));
vi.mock('../config.js', () => ({ config: mocks.config }));
vi.mock('../utils/auth.js', () => ({ authenticate: async (request: any, reply: any) => {
  if (!request.headers.authorization) return reply.code(401).send({ error: 'Unauthorized' });
  request.userId = request.headers.authorization;
} }));
import { ttsRoutes, _resetTtsLimits } from './tts.js';
let app: FastifyInstance;
const headers = { authorization: 'test-user' };
const payload = { text: 'Olá, pessoal!', voice: 'pf_dora', speed: 1 };
function audio(): Buffer { const value = Buffer.alloc(100); value.write('RIFF'); value.write('WAVE', 8); return value; }
beforeEach(async () => {
  _resetTtsLimits(); vi.stubGlobal('fetch', mocks.fetch); mocks.fetch.mockReset(); mocks.config.ttsUrl = 'http://127.0.0.1:5052';
  app = Fastify(); await app.register(ttsRoutes); await app.ready();
});
afterEach(async () => { await app.close(); vi.unstubAllGlobals(); });
it('requires authentication and reports a stopped optional worker without affecting calls', async () => {
  expect((await app.inject({ url: '/api/tts' })).statusCode).toBe(401);
  mocks.fetch.mockRejectedValue(new Error('offline'));
  const status = await app.inject({ url: '/api/tts', headers });
  expect(status.statusCode).toBe(200); expect(status.json().available).toBe(false);
  mocks.config.ttsUrl = undefined;
  expect((await app.inject({ method: 'POST', url: '/api/tts/speech', headers, payload })).json().code).toBe('tts_unavailable');
});
it('validates text and voice, proxies audio only to the configured worker and disables caching', async () => {
  for (const invalid of [{ ...payload, text: 'a'.repeat(401) }, { ...payload, text: ' ' }, { ...payload, voice: '../other' }, { ...payload, speed: 8 }]) {
    expect((await app.inject({ method: 'POST', url: '/api/tts/speech', headers, payload: invalid })).statusCode).toBe(400);
  }
  expect(mocks.fetch).not.toHaveBeenCalled();
  mocks.fetch.mockResolvedValue(new Response(audio(), { headers: { 'Content-Type': 'audio/wav' } }));
  const response = await app.inject({ method: 'POST', url: '/api/tts/speech', headers, payload });
  expect(response.statusCode).toBe(200); expect(response.rawPayload).toEqual(audio());
  expect(response.headers['cache-control']).toBe('no-store');
  expect(mocks.fetch.mock.calls[0]![0]).toBe('http://127.0.0.1:5052/synthesize');
});
it('rejects simultaneous requests from one user and releases capacity after a failure', async () => {
  let finish!: (response: Response) => void;
  mocks.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const first = app.inject({ method: 'POST', url: '/api/tts/speech', headers, payload });
  const waiting = first.then((response) => response);
  await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
  expect((await app.inject({ method: 'POST', url: '/api/tts/speech', headers, payload })).statusCode).toBe(429);
  finish(new Response('offline', { status: 503 })); expect((await waiting).statusCode).toBe(503);
  mocks.fetch.mockResolvedValue(new Response(audio()));
  expect((await app.inject({ method: 'POST', url: '/api/tts/speech', headers, payload })).statusCode).toBe(200);
});
it('rejects non-audio and oversized worker responses', async () => {
  for (const body of [Buffer.from('<html>error</html>'), Buffer.alloc(2_000_001)]) {
    mocks.fetch.mockResolvedValue(new Response(body));
    expect((await app.inject({ method: 'POST', url: '/api/tts/speech', headers, payload })).statusCode).toBe(503);
  }
});
