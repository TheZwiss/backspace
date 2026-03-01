import type { FastifyInstance } from 'fastify';
import { authenticate } from '../utils/auth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { config } from '../config.js';
import { getDb, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import type { Attachment } from '@backspace/shared';

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  // Ensure upload directory exists
  if (!fs.existsSync(config.uploadDir)) {
    fs.mkdirSync(config.uploadDir, { recursive: true });
  }

  // POST /api/uploads - Upload a file
  app.post('/api/uploads', {
    preHandler: authenticate,
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
        keyGenerator: (request: any) => (request as any).userId || request.ip,
      },
    },
  }, async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: 'No file provided', statusCode: 400 });
    }

    const originalName = data.filename;
    const mimetype = data.mimetype;

    // Generate unique filename
    const id = generateSnowflake();
    const ext = path.extname(originalName);
    const filename = `${id}${ext}`;
    const filepath = path.join(config.uploadDir, filename);

    // Save file to disk
    const writeStream = fs.createWriteStream(filepath);
    await pipeline(data.file, writeStream);

    // Get file size
    const stats = fs.statSync(filepath);
    const size = stats.size;

    // Check size limit
    if (size > config.maxUploadSize) {
      fs.unlinkSync(filepath);
      return reply.code(413).send({ error: 'File too large', statusCode: 413 });
    }

    const now = Date.now();
    const db = getDb();

    // Save attachment record
    db.insert(schema.attachments).values({
      id,
      filename,
      originalName,
      mimetype,
      size,
      createdAt: now,
    }).run();

    const attachment: Attachment = {
      id,
      messageId: '',
      filename,
      originalName,
      mimetype,
      size,
      createdAt: now,
    };

    return reply.code(201).send(attachment);
  });

  // GET /api/uploads/:filename - Serve uploaded file
  app.get<{ Params: { filename: string } }>('/api/uploads/:filename', async (request, reply) => {
    const { filename } = request.params;

    // Prevent directory traversal
    const safeName = path.basename(filename);
    const filepath = path.join(config.uploadDir, safeName);

    if (!fs.existsSync(filepath)) {
      return reply.code(404).send({ error: 'File not found', statusCode: 404 });
    }

    // Get mimetype from DB or guess from extension
    const db = getDb();
    const attachment = db.select().from(schema.attachments).where(eq(schema.attachments.filename, safeName)).get();
    const mimetype = attachment?.mimetype ?? 'application/octet-stream';
    const originalName = attachment?.originalName ?? safeName;

    // Set caching headers
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.header('Content-Type', mimetype);

    // For non-image files, set Content-Disposition to download
    if (!mimetype.startsWith('image/') && !mimetype.startsWith('video/') && !mimetype.startsWith('audio/')) {
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(originalName)}"`);
    }

    const stream = fs.createReadStream(filepath);
    return reply.send(stream);
  });
}
