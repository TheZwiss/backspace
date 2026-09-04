import type { FastifyInstance } from 'fastify';
import { authenticate } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors.js';
import { fetchUrlMetadata } from '../utils/metadataFetcher.js';

export async function utilRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { url: string } }>('/api/utils/metadata', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { url } = request.query;

    if (!url) {
      return sendError(reply, 400, 'validation_failed');
    }

    const metadata = await fetchUrlMetadata(url);
    if (!metadata) {
      return reply.code(200).send({});
    }

    return reply.code(200).send(metadata);
  });
}
