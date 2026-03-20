import type { FastifyInstance } from 'fastify';
import { authenticate } from '../utils/auth.js';
import { fetchUrlMetadata } from '../utils/metadataFetcher.js';

export async function utilRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { url: string } }>('/api/utils/metadata', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { url } = request.query;

    if (!url) {
      return reply.code(400).send({ error: 'URL is required' });
    }

    const metadata = await fetchUrlMetadata(url);
    if (!metadata) {
      return reply.code(200).send({});
    }

    return reply.code(200).send(metadata);
  });
}
