import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { config } from '../config.js';
import type { InstanceInfoResponse } from '@backspace/shared';

const BACKSPACE_VERSION = '1.0.0';

export async function instanceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/instance/info', async (_request, reply) => {
    const db = getDb();

    const settings = db.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1)).get();
    const instanceName = settings?.instanceName ?? 'Backspace';

    const response: InstanceInfoResponse = {
      name: instanceName,
      version: BACKSPACE_VERSION,
      registrationOpen: config.registrationOpen,
    };

    return reply.code(200).send(response);
  });
}
