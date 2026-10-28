import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { authenticate } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors.js';
import { createFixedWindowLimit } from '../utils/fixedWindowLimit.js';

const voices = [
  { id: 'pf_dora', name: 'Dora', language: 'pt-BR' },
  { id: 'pm_alex', name: 'Alex', language: 'pt-BR' },
  { id: 'pm_santa', name: 'Santa', language: 'pt-BR' },
];
const limit = createFixedWindowLimit({ max: 45, windowMs: 60_000 });
const pending = new Set<string>();
const MAX_AUDIO = 2_000_000;
export function _resetTtsLimits(): void { limit.reset(); pending.clear(); }

export async function ttsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/tts', { preHandler: authenticate }, async () => {
    let available = false;
    if (config.ttsUrl) {
      try {
        const response = await fetch(`${config.ttsUrl.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
        available = response.ok;
        await response.body?.cancel();
      } catch { /* The optional worker must not affect calls. */ }
    }
    return { available, voices, maxLength: 400 };
  });

  app.post<{ Body: { text: string; voice: string; speed: number } }>('/api/tts/speech', {
    preHandler: authenticate, bodyLimit: 4096,
    schema: { body: { type: 'object', additionalProperties: false, required: ['text', 'voice', 'speed'], properties: {
      text: { type: 'string', minLength: 1, maxLength: 400 },
      voice: { type: 'string', enum: voices.map((voice) => voice.id) },
      speed: { type: 'number', minimum: 0.8, maximum: 1.3 },
    } } },
  }, async (request, reply) => {
    if (!request.body.text.trim()) return sendError(reply, 400, 'validation_failed');
    if (!config.ttsUrl) return sendError(reply, 503, 'tts_unavailable');
    if (pending.has(request.userId) || pending.size >= 4 || !limit.consume(request.userId)) return sendError(reply, 429, 'rate_limited');
    pending.add(request.userId);
    try {
      const response = await fetch(`${config.ttsUrl.replace(/\/$/, '')}/synthesize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(15_000), redirect: 'error',
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return sendError(reply, 503, 'tts_unavailable');
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_AUDIO) { await reader.cancel(); return sendError(reply, 503, 'tts_unavailable'); }
        chunks.push(value);
      }
      const audio = Buffer.concat(chunks);
      if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') return sendError(reply, 503, 'tts_unavailable');
      return reply.type('audio/wav').header('Cache-Control', 'no-store').send(audio);
    } catch { return sendError(reply, 503, 'tts_unavailable'); }
    finally { pending.delete(request.userId); }
  });
}
