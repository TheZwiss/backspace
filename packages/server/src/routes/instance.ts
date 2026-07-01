import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { config } from '../config.js';
import { getInstanceId } from '../utils/federationEpoch.js';
import type { InstanceInfoResponse } from '@backspace/shared';

const BACKSPACE_VERSION = '1.0.0';

export async function instanceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/instance/info', async (_request, reply) => {
    const db = getDb();

    const settings = db.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1)).get();
    const instanceName = settings?.instanceName ?? 'Backspace';

    // DB setting overrides env var if explicitly set by admin
    const registrationOpen = settings?.registrationOpen !== null && settings?.registrationOpen !== undefined
      ? settings.registrationOpen === 1
      : config.registrationOpen;

    const response: InstanceInfoResponse = {
      name: instanceName,
      version: BACKSPACE_VERSION,
      registrationOpen,
      federatedRegistrationOpen: settings?.federatedRegistrationOpen === 1,
      instanceId: getInstanceId(),
      // AGPL-3.0 § 13: advertise the source of the running version to every
      // network user (and federated peer) — public/unauthenticated by design.
      sourceCodeUrl: config.sourceCodeUrl,
      commit: config.commit,
    };

    return reply.code(200).send(response);
  });
}
