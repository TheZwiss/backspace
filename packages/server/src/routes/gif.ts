import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import type { GifResult } from '@backspace/shared';

interface KlipyGifFile {
  url: string;
  width: number;
  height: number;
  size: number;
}

interface KlipySizeTier {
  gif?: KlipyGifFile;
  webp?: KlipyGifFile;
  mp4?: KlipyGifFile;
  jpg?: KlipyGifFile;
  webm?: KlipyGifFile;
}

interface KlipyGif {
  id: number;
  slug: string;
  title: string;
  file: {
    hd?: KlipySizeTier;
    md?: KlipySizeTier;
    sm?: KlipySizeTier;
    xs?: KlipySizeTier;
  };
}

interface KlipyResponse {
  result: boolean;
  data: {
    data: KlipyGif[];
    current_page: number;
    per_page: number;
    has_next: boolean;
  };
}

function mapKlipyResults(gifs: KlipyGif[]): GifResult[] {
  return gifs
    .map((g) => {
      if (!g.file) return null;
      // Preview: small tier, prefer webp (smaller) then gif
      const smTier = g.file.sm ?? g.file.xs;
      const preview = smTier?.webp ?? smTier?.gif;
      // Full: HD tier, prefer gif (original quality) then webp
      const hdTier = g.file.hd ?? g.file.md;
      const full = hdTier?.gif ?? hdTier?.webp;
      if (!preview || !full) return null;
      return {
        id: g.slug || String(g.id),
        title: g.title ?? '',
        previewUrl: preview.url,
        url: full.url,
        width: preview.width,
        height: preview.height,
      };
    })
    .filter((r): r is GifResult => r !== null);
}

function getGifApiKey(): string | null {
  const db = getDb();
  const row = db.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1)).get();
  return row?.gifApiKey ?? null;
}

export async function gifRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/gif/enabled — any authenticated user, returns whether GIF search is available
  app.get('/api/gif/enabled', { preHandler: authenticate }, async (_request, reply) => {
    const key = getGifApiKey();
    return reply.code(200).send({ enabled: !!key });
  });

  // GET /api/gif/trending
  app.get<{ Querystring: { limit?: string; pos?: string } }>('/api/gif/trending', {
    preHandler: authenticate,
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
        keyGenerator: (request: any) => request.userId || request.ip,
      },
    },
  }, async (request, reply) => {
    const key = getGifApiKey();
    if (!key) {
      return reply.code(200).send({ results: [], next: '' });
    }

    const perPage = Math.min(Math.max(Number(request.query.limit) || 24, 1), 50);
    const page = Number(request.query.pos) || 1;

    try {
      const params = new URLSearchParams({
        per_page: String(perPage),
        page: String(page),
      });

      const response = await fetch(`https://api.klipy.com/api/v1/${encodeURIComponent(key)}/gifs/trending?${params}`);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        console.error(`[GIF] Klipy trending error: HTTP ${response.status} — ${body.slice(0, 200)}`);
        return reply.code(200).send({ results: [], next: '' });
      }

      const data = (await response.json()) as KlipyResponse;
      if (!data.result || !data.data) {
        console.error('[GIF] Klipy trending returned result=false or missing data');
        return reply.code(200).send({ results: [], next: '' });
      }

      return reply.code(200).send({
        results: mapKlipyResults(data.data.data),
        next: data.data.has_next ? String(data.data.current_page + 1) : '',
      });
    } catch (err) {
      console.error('[GIF] Klipy trending fetch failed:', err);
      return reply.code(200).send({ results: [], next: '' });
    }
  });

  // GET /api/gif/search
  app.get<{ Querystring: { q?: string; limit?: string; pos?: string } }>('/api/gif/search', {
    preHandler: authenticate,
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
        keyGenerator: (request: any) => request.userId || request.ip,
      },
    },
  }, async (request, reply) => {
    const key = getGifApiKey();
    if (!key) {
      return reply.code(200).send({ results: [], next: '' });
    }

    const q = request.query.q?.trim();
    if (!q) {
      return reply.code(400).send({ error: 'Search query is required', statusCode: 400 });
    }

    const perPage = Math.min(Math.max(Number(request.query.limit) || 24, 1), 50);
    const page = Number(request.query.pos) || 1;

    try {
      const params = new URLSearchParams({
        q,
        per_page: String(perPage),
        page: String(page),
      });

      const response = await fetch(`https://api.klipy.com/api/v1/${encodeURIComponent(key)}/gifs/search?${params}`);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        console.error(`[GIF] Klipy search error: HTTP ${response.status} — ${body.slice(0, 200)}`);
        return reply.code(200).send({ results: [], next: '' });
      }

      const data = (await response.json()) as KlipyResponse;
      if (!data.result || !data.data) {
        console.error('[GIF] Klipy search returned result=false or missing data');
        return reply.code(200).send({ results: [], next: '' });
      }

      return reply.code(200).send({
        results: mapKlipyResults(data.data.data),
        next: data.data.has_next ? String(data.data.current_page + 1) : '',
      });
    } catch (err) {
      console.error('[GIF] Klipy search fetch failed:', err);
      return reply.code(200).send({ results: [], next: '' });
    }
  });
}
