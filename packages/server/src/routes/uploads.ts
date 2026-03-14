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
import { generateThumbnail, isResizableImage } from '../utils/thumbnail.js';

const EXT_MIMETYPES: Record<string, string> = {
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.avif': 'image/avif', '.tiff': 'image/tiff', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.flac': 'audio/flac', '.aac': 'audio/aac', '.opus': 'audio/opus',
  '.pdf': 'application/pdf',
};

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

    // Generate thumbnail for resizable images (non-blocking — upload succeeds regardless)
    let thumbnailFilename: string | null = null;
    if (isResizableImage(mimetype)) {
      thumbnailFilename = await generateThumbnail(filepath, mimetype, config.uploadDir);
    }

    // Save attachment record
    db.insert(schema.attachments).values({
      id,
      uploaderId: request.userId,
      filename,
      originalName,
      mimetype,
      size,
      thumbnailFilename,
      createdAt: now,
    }).run();

    const attachment: Attachment = {
      id,
      messageId: '',
      filename,
      originalName,
      mimetype,
      size,
      thumbnailFilename: thumbnailFilename ?? undefined,
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

    // Get mimetype from DB, falling back to extension-based lookup for thumbnails/orphans
    const db = getDb();
    const attachment = db.select().from(schema.attachments).where(eq(schema.attachments.filename, safeName)).get();
    const originalName = attachment?.originalName ?? safeName;
    const mimetype = attachment?.mimetype
      ?? EXT_MIMETYPES[path.extname(safeName).toLowerCase()]
      ?? 'application/octet-stream';

    // Set caching and security headers
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.header('Content-Type', mimetype);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'");
    reply.header('X-Frame-Options', 'DENY');

    // For non-media files and SVGs, force download instead of inline rendering
    const isSvg = mimetype === 'image/svg+xml';
    if (isSvg || (!mimetype.startsWith('image/') && !mimetype.startsWith('video/') && !mimetype.startsWith('audio/'))) {
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(originalName)}"`);
    }

    const stream = fs.createReadStream(filepath);
    return reply.send(stream);
  });
}
