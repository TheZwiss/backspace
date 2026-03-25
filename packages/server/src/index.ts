import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { getDb, getRawDb } from './db/index.js';
import { seedDatabase } from './db/seed.js';
import { backfillThumbnails, backfillMediaDimensions } from './db/migrate.js';
import { checkFfmpeg } from './utils/thumbnail.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { spaceRoutes } from './routes/spaces.js';
import { channelRoutes } from './routes/channels.js';
import { messageRoutes } from './routes/messages.js';
import { uploadRoutes } from './routes/uploads.js';
import { dmRoutes } from './routes/dm.js';
import { livekitRoutes } from './routes/livekit.js';
import { socialRoutes } from './routes/social.js';
import { settingsRoutes } from './routes/settings.js';
import { utilRoutes } from './routes/utils.js';
import { instanceRoutes } from './routes/instance.js';
import { exploreRoutes } from './routes/explore.js';
import { searchRoutes } from './routes/search.js';
import { adminRoutes } from './routes/admin.js';
import { gifRoutes } from './routes/gif.js';
import { federationRoutes } from './routes/federation.js';

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
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
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

  await app.register(multipart, {
    limits: {
      fileSize: 5 * 1024 * 1024 * 1024,  // 5GB hard ceiling — actual limit enforced per-request from DB
    },
  });

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

  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(spaceRoutes);
  await app.register(channelRoutes);
  await app.register(messageRoutes);
  await app.register(uploadRoutes);
  await app.register(dmRoutes);
  await app.register(livekitRoutes);
  await app.register(socialRoutes);
  await app.register(settingsRoutes);
  await app.register(utilRoutes);
  await app.register(instanceRoutes);
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

  // Fire-and-forget: backfill thumbnails for existing images (runs once)
  backfillThumbnails(getRawDb(), config.uploadDir).catch(err => {
    console.error('Thumbnail backfill failed (non-fatal):', err);
  });

  // Log ffmpeg availability at startup (so admins see the warning immediately)
  checkFfmpeg();

  // Fire-and-forget: backfill dimensions for existing media (runs once)
  backfillMediaDimensions(getRawDb(), config.uploadDir).catch(err => {
    console.error('Media dimensions backfill failed (non-fatal):', err);
  });

  const shutdown = async () => {
    console.log('Shutting down...');
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
