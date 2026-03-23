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
import { generateThumbnail, isResizableImage, probeImageDimensions, probeMediaMeta, generateVideoThumbnail } from '../utils/thumbnail.js';

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
    // Read dynamic upload limit from instance settings
    const db = getDb();
    const settings = db.select({ maxUploadSizeBytes: schema.instanceSettings.maxUploadSizeBytes })
      .from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1)).get();
    const maxSize = settings?.maxUploadSizeBytes ?? config.maxUploadSize;

    const data = await request.file({ limits: { fileSize: maxSize } });
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

    // Check if file was truncated by multipart limit
    if ((data.file as any).truncated) {
      fs.unlinkSync(filepath);
      return reply.code(413).send({ error: 'File too large', statusCode: 413 });
    }

    // Get file size
    const stats = fs.statSync(filepath);
    const size = stats.size;

    const now = Date.now();

    // ─── Media processing ────────────────────────────────────────────────────
    let thumbnailFilename: string | null = null;
    let width: number | null = null;
    let height: number | null = null;
    let duration: number | null = null;

    if (isResizableImage(mimetype)) {
      // Image: generate thumbnail (unchanged) + probe dimensions
      thumbnailFilename = await generateThumbnail(filepath, mimetype, config.uploadDir);
      const dims = await probeImageDimensions(filepath);
      if (dims) {
        width = dims.width;
        height = dims.height;
      }
    } else if (mimetype.startsWith('video/')) {
      // Video: generate thumbnail frame + probe duration
      const videoThumb = await generateVideoThumbnail(filepath, config.uploadDir);
      if (videoThumb) {
        thumbnailFilename = videoThumb.thumbnailFilename;
        width = videoThumb.width;
        height = videoThumb.height;
      }
      // Duration (and fallback dimensions if thumbnail failed)
      const meta = await probeMediaMeta(filepath, mimetype);
      if (meta) {
        duration = meta.duration ?? null;
        if (width === null && meta.width) width = meta.width;
        if (height === null && meta.height) height = meta.height;
      }
    } else if (mimetype.startsWith('audio/')) {
      // Audio: duration only
      const meta = await probeMediaMeta(filepath, mimetype);
      if (meta?.duration) duration = meta.duration;
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
      width,
      height,
      duration,
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
      width: width ?? undefined,
      height: height ?? undefined,
      duration: duration ?? undefined,
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

    // Support Range requests for audio/video seeking
    const stat = fs.statSync(filepath);
    const fileSize = stat.size;
    const rangeHeader = request.headers.range;

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0] ?? '0', 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      reply.header('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Content-Length', chunkSize);
      reply.code(206);

      const stream = fs.createReadStream(filepath, { start, end });
      return reply.send(stream);
    }

    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Length', fileSize);
    const stream = fs.createReadStream(filepath);
    return reply.send(stream);
  });
}
