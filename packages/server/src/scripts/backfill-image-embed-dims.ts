/**
 * One-time backfill: populate width/height for image embeds that lack them,
 * and create image embeds for old bare-image-URL messages that never got one
 * (these predate the `resolveEmbeds` call site in routes/messages.ts).
 *
 * Idempotent — re-running skips already-dim'd rows and already-embedded
 * messages via the WHERE clauses.
 *
 * Run from the running container:
 *   docker exec backspace node dist/scripts/backfill-image-embed-dims.js
 */
import fs from 'fs';
import path from 'path';
import { initDatabase, getRawDb, schema } from '../db/index.js';
import { probeRemoteImageDimensions } from '../utils/embedResolver.js';
import { extractUrls } from '../utils/embedResolver.js';
import { classifyUrl } from '../utils/embedClassifier.js';
import { probeImageDimensions } from '../utils/thumbnail.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { config } from '../config.js';

const CONCURRENCY = 4;

interface PendingProbe {
  kind: 'update-embed' | 'create-embed-for-message' | 'create-embed-for-dm-message';
  url: string;
  embedId?: string;
  messageId?: string;
  dmMessageId?: string;
}

async function withConcurrency<T>(items: T[], n: number, worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      const item = items[idx];
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function isLikelyImageUrl(url: string): boolean {
  return classifyUrl(url).embedType === 'image';
}

async function main(): Promise<void> {
  // initDatabase() runs migrations + ensureDefaults + sets the snowflake
  // worker ID from instance_settings.worker_id. We rely on that for
  // generateSnowflake() below.
  initDatabase();
  const db = getRawDb();

  // ── Pass 1: image embeds missing dimensions ──────────────────────────────
  const nullDimEmbeds = db.prepare(
    `SELECT id, url FROM embeds WHERE embed_type = 'image' AND (width IS NULL OR height IS NULL)`,
  ).all() as Array<{ id: string; url: string }>;
  console.log(`[backfill] Found ${nullDimEmbeds.length} image embeds missing width/height`);

  // ── Pass 2: messages with bare image URLs but no embed row ───────────────
  // SQLite has no REGEXP by default; use LIKE with the two known providers
  // plus a generic suffix match. We re-classify each candidate URL with
  // classifyUrl() before probing so non-image extensions are filtered out.
  const candidateMessages = db.prepare(
    `SELECT m.id, m.content
       FROM messages m
       LEFT JOIN embeds e ON e.message_id = m.id
       WHERE m.content IS NOT NULL
         AND (
           m.content LIKE 'https://media.tenor.com/%'
           OR m.content LIKE 'https://static.klipy.com/%'
           OR m.content LIKE '%.gif'
           OR m.content LIKE '%.webp'
         )
         AND e.id IS NULL`,
  ).all() as Array<{ id: string; content: string }>;
  console.log(`[backfill] Found ${candidateMessages.length} channel messages with image URLs and no embed`);

  const candidateDmMessages = db.prepare(
    `SELECT m.id, m.content
       FROM dm_messages m
       LEFT JOIN embeds e ON e.dm_message_id = m.id
       WHERE m.content IS NOT NULL
         AND (
           m.content LIKE 'https://media.tenor.com/%'
           OR m.content LIKE 'https://static.klipy.com/%'
           OR m.content LIKE '%.gif'
           OR m.content LIKE '%.webp'
         )
         AND e.id IS NULL`,
  ).all() as Array<{ id: string; content: string }>;
  console.log(`[backfill] Found ${candidateDmMessages.length} DM messages with image URLs and no embed`);

  // ── Build work queue ─────────────────────────────────────────────────────
  const work: PendingProbe[] = [];

  for (const row of nullDimEmbeds) {
    work.push({ kind: 'update-embed', url: row.url, embedId: row.id });
  }

  for (const m of candidateMessages) {
    const urls = extractUrls(m.content);
    for (const url of urls) {
      if (isLikelyImageUrl(url)) {
        work.push({ kind: 'create-embed-for-message', url, messageId: m.id });
      }
    }
  }

  for (const m of candidateDmMessages) {
    const urls = extractUrls(m.content);
    for (const url of urls) {
      if (isLikelyImageUrl(url)) {
        work.push({ kind: 'create-embed-for-dm-message', url, dmMessageId: m.id });
      }
    }
  }

  // ── Pass 3: image attachments missing dimensions ─────────────────────────
  // Probe local files directly (the upload sits on the same filesystem). The
  // `failOn: 'none'` flag in `probeImageDimensions` handles animated GIFs
  // whose default sharp probe was failing on frame-data validation.
  const nullDimAttachments = db.prepare(
    `SELECT id, filename FROM attachments WHERE mimetype LIKE 'image/%' AND (width IS NULL OR height IS NULL)`,
  ).all() as Array<{ id: string; filename: string }>;
  console.log(`[backfill] Found ${nullDimAttachments.length} image attachments missing width/height`);

  const updateAttachment = db.prepare(`UPDATE attachments SET width = ?, height = ? WHERE id = ?`);
  let attachmentSuccesses = 0;
  let attachmentSkipped = 0;
  for (const a of nullDimAttachments) {
    const filepath = path.join(config.uploadDir, a.filename);
    if (!fs.existsSync(filepath)) {
      // Federated remote attachments live on the source instance, not here.
      // Their dims need to be backfilled from the source side, or via the
      // federation file-replication path. Skip silently.
      attachmentSkipped++;
      continue;
    }
    const dims = await probeImageDimensions(filepath);
    if (dims) {
      updateAttachment.run(dims.width, dims.height, a.id);
      attachmentSuccesses++;
    }
  }
  console.log(`[backfill] attachments updated=${attachmentSuccesses}, skipped (file not local)=${attachmentSkipped}`);

  // ── Pass 4: image embeds whose URL points at our local uploads ───────────
  // SSRF correctly blocks the remote probe from hitting our own host. For
  // these specific embeds we have the file locally — extract the upload
  // filename from the URL path (`/api/uploads/<filename>`) and probe it
  // directly, sidestepping HTTP entirely. Federated `/api/uploads/...` URLs
  // on a different host won't have a local file and are skipped.
  const localUploadEmbeds = db.prepare(
    `SELECT id, url FROM embeds WHERE embed_type = 'image' AND (width IS NULL OR height IS NULL) AND url LIKE '%/api/uploads/%'`,
  ).all() as Array<{ id: string; url: string }>;
  console.log(`[backfill] Found ${localUploadEmbeds.length} image embeds pointing at /api/uploads`);

  const updateEmbedDims = db.prepare(`UPDATE embeds SET width = ?, height = ? WHERE id = ?`);
  let localEmbedSuccesses = 0;
  let localEmbedSkipped = 0;
  for (const e of localUploadEmbeds) {
    const match = e.url.match(/\/api\/uploads\/([^/?#]+)/);
    if (!match || !match[1]) { localEmbedSkipped++; continue; }
    const filepath = path.join(config.uploadDir, match[1]);
    if (!fs.existsSync(filepath)) { localEmbedSkipped++; continue; }
    const dims = await probeImageDimensions(filepath);
    if (dims) {
      updateEmbedDims.run(dims.width, dims.height, e.id);
      localEmbedSuccesses++;
    }
  }
  console.log(`[backfill] local-upload embeds updated=${localEmbedSuccesses}, skipped (no local file)=${localEmbedSkipped}`);

  console.log(`[backfill] ${work.length} remote probes to run (concurrency=${CONCURRENCY})`);

  // ── Execute ──────────────────────────────────────────────────────────────
  const updateEmbed = db.prepare(
    `UPDATE embeds SET width = ?, height = ? WHERE id = ?`,
  );
  const insertEmbed = db.prepare(
    `INSERT INTO embeds (id, message_id, dm_message_id, url, embed_type, provider, title, description, image, embed_url, width, height, color, created_at)
       VALUES (?, ?, ?, ?, 'image', NULL, NULL, NULL, ?, NULL, ?, ?, NULL, ?)`,
  );

  let successes = 0;
  let probeFailures = 0;
  let progress = 0;

  await withConcurrency(work, CONCURRENCY, async (item) => {
    const dims = await probeRemoteImageDimensions(item.url);
    progress++;
    if (progress % 25 === 0) {
      console.log(`[backfill] progress ${progress}/${work.length} (ok=${successes}, fail=${probeFailures})`);
    }
    if (!dims) {
      probeFailures++;
      return;
    }
    if (item.kind === 'update-embed' && item.embedId) {
      updateEmbed.run(dims.width, dims.height, item.embedId);
      successes++;
    } else if (item.kind === 'create-embed-for-message' && item.messageId) {
      insertEmbed.run(
        generateSnowflake(),
        item.messageId,
        null,
        item.url,
        item.url,
        dims.width,
        dims.height,
        Date.now(),
      );
      successes++;
    } else if (item.kind === 'create-embed-for-dm-message' && item.dmMessageId) {
      insertEmbed.run(
        generateSnowflake(),
        null,
        item.dmMessageId,
        item.url,
        item.url,
        dims.width,
        dims.height,
        Date.now(),
      );
      successes++;
    }
  });

  console.log(`[backfill] done. successes=${successes}, probe-failures=${probeFailures}, total=${work.length}`);
  // Silence the schema import linter — it's intentionally available for
  // future per-table tweaks without re-importing.
  void schema;
  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});
