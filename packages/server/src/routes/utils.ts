import type { FastifyInstance } from 'fastify';
import { authenticate } from '../utils/auth.js';
import * as cheerio from 'cheerio';

export async function utilRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { url: string } }>('/api/utils/metadata', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { url } = request.query;

    if (!url) {
      return reply.code(400).send({ error: 'URL is required' });
    }

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'OpencordBot/1.0',
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch URL');
      }

      const html = await response.text();
      const $ = cheerio.load(html);

      const metadata = {
        title: $('meta[property="og:title"]').attr('content') || $('title').text(),
        description: $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content'),
        image: $('meta[property="og:image"]').attr('content'),
        siteName: $('meta[property="og:site_name"]').attr('content'),
        url: url,
      };

      return reply.code(200).send(metadata);
    } catch (err) {
      return reply.code(200).send({}); // Fail silently with empty object
    }
  });
}
