import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, getRawDb, schema } from '../db/index.js';
import { config } from '../config.js';
import { getInstanceId } from '../utils/federationEpoch.js';
import { readDirectoryBrowseEnabled } from '../directory/state.js';
import type { InstanceInfoResponse } from '@backspace/shared';

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
      version: config.version,
      registrationOpen,
      federatedRegistrationOpen: settings?.federatedRegistrationOpen === 1,
      instanceId: getInstanceId(),
      // AGPL-3.0 § 13: advertise the source of the running version to every
      // network user (and federated peer) — public/unauthenticated by design.
      sourceCodeUrl: config.sourceCodeUrl,
      commit: config.commit,
      // Reported on its own, not folded into the two below it. Whether this
      // instance has a hub to talk to is the fact every directory promise
      // rests on, and a client that could only see `directoryAvailable` had
      // no way to tell a missing endpoint from an admin who turned browsing
      // off, so it offered listing and browsing on instances where neither
      // could happen.
      directoryConfigured: config.directory.endpoint !== '',
      // Browsing needs an endpoint to reach and the admin's permission to use
      // it. The endpoint is asked first: it is the operator-level switch, and
      // the admin's flag cannot conjure a directory that is not configured.
      // Listing is the other axis entirely, and its own opt-in below.
      directoryAvailable: config.directory.endpoint !== '' && readDirectoryBrowseEnabled(getRawDb()),
      directoryEnabled: settings?.directoryEnabled === 1,
    };

    return reply.code(200).send(response);
  });
}
