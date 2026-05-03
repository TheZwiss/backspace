import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { getDb, getRawDb } from './db/index.js';
import { seedDatabase } from './db/seed.js';
import { checkFfmpeg } from './utils/thumbnail.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { spaceRoutes } from './routes/spaces.js';
import { channelRoutes } from './routes/channels.js';
import { messageRoutes } from './routes/messages.js';
import { uploadRoutes } from './routes/uploads.js';
import { filesRoutes } from './routes/files.js';
import { dmRoutes } from './routes/dm.js';
import { livekitRoutes } from './routes/livekit.js';
import { socialRoutes } from './routes/social.js';
import { settingsRoutes } from './routes/settings.js';
import { utilRoutes } from './routes/utils.js';
import { instanceRoutes } from './routes/instance.js';
import { invitesRoutes } from './routes/invites.js';
import { exploreRoutes } from './routes/explore.js';
import { searchRoutes } from './routes/search.js';
import { adminRoutes } from './routes/admin.js';
import { gifRoutes } from './routes/gif.js';
import { federationRoutes } from './routes/federation.js';
import { startFederationWorkers, stopFederationWorkers } from './utils/federationWorker.js';
import './utils/federationRollback.js'; // Side-effect: registers rollback callbacks for outbox terminal failures.
import { registerCallRelayHooks } from './ws/events.js';
import { resetStalePresenceOnBoot } from './utils/presenceBoot.js';

import { registerWebSocket } from './ws/handler.js';
import path from 'path';
import fs from 'fs';

async function main(): Promise<void> {
  const app = Fastify({
    trustProxy: true,
    logger: {
      level: 'info',
    },
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    // Tus-* and Upload-* headers are required for federated tus uploads
    // (cross-origin POST/HEAD/PATCH/DELETE on /api/files/*). Without them the
    // browser preflight blocks the request before it ever reaches the server.
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Tus-Resumable',
      'Upload-Length',
      'Upload-Offset',
      'Upload-Metadata',
      'Upload-Defer-Length',
      'Upload-Concat',
      'Upload-Checksum',
      'X-HTTP-Method-Override',
    ],
    // Expose tus response headers so tus-js-client can read them across origins
    // (Location is the per-upload URL returned on POST; the rest are standard
    // tus protocol headers).
    exposedHeaders: [
      'Location',
      'Tus-Resumable',
      'Tus-Version',
      'Tus-Extension',
      'Tus-Max-Size',
      'Tus-Checksum-Algorithm',
      'Upload-Offset',
      'Upload-Length',
      'Upload-Metadata',
      'Upload-Expires',
    ],
  });

  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    keyGenerator: (request) => (request as any).userId || request.ip,
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded',
      retryAfter: Math.ceil(context.ttl / 1000),
    }),
  });

  await app.register(websocket);

  // Serve built frontend in production
  const webDistPath = path.resolve(import.meta.dirname ?? '.', '../../web/dist');
  if (fs.existsSync(webDistPath)) {
    await app.register(fastifyStatic, {
      root: webDistPath,
      prefix: '/',
      wildcard: false,
    });
  }

  // Initialize database
  getDb();
  await seedDatabase();

  // Reset orphaned `users.status` rows for locally-homed users. The previous
  // process's in-memory disconnect timers are gone, so any non-offline row
  // is stale by construction. Replicated (federated) rows are skipped — their
  // status is a projection of remote presence, not local WS state. Must run
  // before WS auth is accepted so the first connection broadcasts the correct
  // online transition. See utils/presenceBoot.ts.
  resetStalePresenceOnBoot();

  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(spaceRoutes);
  await app.register(channelRoutes);
  await app.register(messageRoutes);
  await app.register(uploadRoutes);
  await app.register(filesRoutes);
  await app.register(dmRoutes);
  await app.register(livekitRoutes);
  await app.register(socialRoutes);
  await app.register(settingsRoutes);
  await app.register(utilRoutes);
  await app.register(instanceRoutes);
  await app.register(invitesRoutes);
  await app.register(exploreRoutes);
  await app.register(searchRoutes);
  await app.register(adminRoutes);
  await app.register(gifRoutes);
  await app.register(federationRoutes);
  await app.register(registerWebSocket);

  app.get('/api/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

  // SPA fallback - serve index.html for non-API routes
  if (fs.existsSync(webDistPath)) {
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'Not found', statusCode: 404 });
      }
      return reply.sendFile('index.html');
    });
  }

  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`Backspace server running at http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Log ffmpeg availability at startup (so admins see the warning immediately)
  checkFfmpeg();

  // Register WS-layer call relay hooks (ring-timeout fan-out).
  registerCallRelayHooks();

  // Start federation background workers (outbox delivery, file download, health check,
  // storage janitor, federated-call sentinel). Skip when DISABLE_FEDERATION_WORKERS is
  // set to '1' or 'true' (matches envBool semantics in config.ts; used by integration
  // tests to keep two-instance harnesses quiet).
  const disableWorkers = process.env.DISABLE_FEDERATION_WORKERS === '1'
    || process.env.DISABLE_FEDERATION_WORKERS === 'true';
  if (disableWorkers) {
    console.log('[startup] federation workers disabled via DISABLE_FEDERATION_WORKERS');
  } else {
    startFederationWorkers();
  }

  const shutdown = async () => {
    console.log('Shutting down...');
    stopFederationWorkers();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
