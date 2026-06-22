import { eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import type { Embed } from '@backspace/shared';
import { getDb, schema } from '../db/index.js';
import { generateSnowflake } from './snowflake.js';
import { classifyUrl } from './embedClassifier.js';
import { fetchUrlMetadata } from './metadataFetcher.js';
import { safeFetch } from './ssrf.js';
import { connectionManager } from '../ws/handler.js';

const MAX_EMBEDS_PER_MESSAGE = 5;

const PROBE_BYTES = 32_768; // 32KB — sufficient for common image headers
const PROBE_TIMEOUT_MS = 3_000;

/**
 * Fetch just enough bytes from a remote image URL to determine its dimensions.
 * Uses Range request to avoid downloading the entire file.
 * Returns null on any failure (timeout, network, unrecognized format, SSRF block).
 */
export async function probeRemoteImageDimensions(
  url: string,
): Promise<{ width: number; height: number } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await safeFetch(url, {
      headers: {
        'User-Agent': 'BackspaceBot/1.0',
        Accept: 'image/*',
        Range: `bytes=0-${PROBE_BYTES - 1}`,
      },
      signal: controller.signal,
    });
    // NOTE: Do NOT clearTimeout here — keep the abort active during body read.
    // The finally block handles cleanup after all reads complete.

    if (!response.ok && response.status !== 206) return null;
    if (!response.body) return null;

    // Read up to PROBE_BYTES regardless of whether server honored Range
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;

    while (bytesRead < PROBE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytesRead += value.length;
    }
    reader.cancel().catch(() => {}); // Aggressively close the connection

    const buffer = Buffer.concat(chunks);
    const metadata = await sharp(buffer).metadata();

    if (metadata.width && metadata.height && metadata.width > 0 && metadata.height > 0) {
      return { width: metadata.width, height: metadata.height };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── URL Extraction ────────────────────────────────────────────────────────

export function extractUrls(content: string | null): string[] {
  if (!content) return [];

  const matches = content.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/g);
  if (!matches) return [];

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const url of matches) {
    if (!seen.has(url)) {
      seen.add(url);
      unique.push(url);
    }
  }

  return unique.slice(0, MAX_EMBEDS_PER_MESSAGE);
}

// ─── Row → Embed Conversion ────────────────────────────────────────────────

export function embedRowToEmbed(row: typeof schema.embeds.$inferSelect): Embed {
  return {
    id: row.id,
    messageId: row.messageId,
    dmMessageId: row.dmMessageId,
    url: row.url,
    embedType: row.embedType as Embed['embedType'],
    provider: (row.provider ?? null) as Embed['provider'],
    title: row.title ?? null,
    description: row.description ?? null,
    image: row.image ?? null,
    embedUrl: row.embedUrl ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    color: row.color ?? null,
    createdAt: row.createdAt,
  };
}

// ─── Embed Resolution ─────────────────────────────────────────────────────

export async function resolveEmbeds(
  messageId: string,
  content: string | null,
  channelId: string,
  isDm: boolean,
  spaceId: string | null,
): Promise<void> {
  const urls = extractUrls(content);
  if (urls.length === 0) return;

  const db = getDb();
  const now = Date.now();
  const resolvedEmbeds: Embed[] = [];

  for (const url of urls) {
    try {
      const classification = classifyUrl(url);

      let title: string | null = null;
      let description: string | null = null;
      let image: string | null = null;
      let siteName: string | null = null;
      let width: number | null = null;
      let height: number | null = null;

      // Track the effective embed type (may be overridden by Content-Type detection)
      let effectiveEmbedType = classification.embedType;

      // For YouTube/Vimeo, use predictable thumbnail URLs as fallback
      if (classification.provider === 'youtube' && classification.embedUrl) {
        const ytId = classification.embedUrl.split('/').pop()?.split('?')[0];
        if (ytId) {
          image = `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
          width = 480;   // hqdefault.jpg is always 480x360
          height = 360;
        }
      }

      if (classification.embedType === 'image') {
        // Direct image URL — no fetch needed, use the URL as the image source
        image = url;
      } else if (classification.needsMetadataFetch) {
        const metadata = await fetchUrlMetadata(url);
        if (metadata) {
          // If the URL itself is a direct media resource (detected via Content-Type),
          // override the classification instead of trying to use og: metadata
          if (metadata.contentType) {
            if (metadata.contentType.startsWith('image/')) {
              effectiveEmbedType = 'image';
              image = url;
            } else if (metadata.contentType.startsWith('video/')) {
              effectiveEmbedType = 'video';
            } else if (metadata.contentType.startsWith('audio/')) {
              effectiveEmbedType = 'audio';
            }
          } else {
            title = metadata.title || title;
            description = metadata.description || description;
            image = metadata.image || image;
            siteName = metadata.siteName;

            // Extract OG dimensions (only from HTML pages, not direct media)
            if (metadata.imageWidth && metadata.imageHeight) {
              width = width ?? metadata.imageWidth;
              height = height ?? metadata.imageHeight;
            }
          }
        }

        // For generic embeds, skip if we couldn't extract a title and it's not a media URL
        if (effectiveEmbedType === 'generic' && !title) {
          continue;
        }
      }

      // Probe direct image URLs for dimensions if not already known
      if (effectiveEmbedType === 'image' && image && width === null) {
        const dims = await probeRemoteImageDimensions(image);
        if (dims) {
          width = dims.width;
          height = dims.height;
        }
      }

      const embedId = generateSnowflake();
      const row: typeof schema.embeds.$inferInsert = {
        id: embedId,
        messageId: isDm ? null : messageId,
        dmMessageId: isDm ? messageId : null,
        url,
        embedType: effectiveEmbedType,
        provider: classification.provider,
        title,
        description,
        image,
        embedUrl: classification.embedUrl,
        width,
        height,
        color: null,
        createdAt: now,
      };

      db.insert(schema.embeds).values(row).run();

      resolvedEmbeds.push(embedRowToEmbed(row as typeof schema.embeds.$inferSelect));
    } catch {
      // One URL failure must not block the rest
      continue;
    }
  }

  if (resolvedEmbeds.length === 0) return;

  if (isDm) {
    connectionManager.sendToDmMembers(channelId, {
      type: 'dm_embeds_resolved',
      messageId,
      dmChannelId: channelId,
      embeds: resolvedEmbeds,
    });
  } else {
    if (!spaceId) return;
    connectionManager.sendToChannel(spaceId, channelId, {
      type: 'embeds_resolved',
      messageId,
      channelId,
      embeds: resolvedEmbeds,
    });
  }
}

// ─── Re-resolution (on message edit) ──────────────────────────────────────

export async function reResolveEmbeds(
  messageId: string,
  content: string | null,
  channelId: string,
  isDm: boolean,
  spaceId: string | null,
): Promise<void> {
  const db = getDb();

  if (isDm) {
    db.delete(schema.embeds)
      .where(eq(schema.embeds.dmMessageId, messageId))
      .run();
  } else {
    db.delete(schema.embeds)
      .where(eq(schema.embeds.messageId, messageId))
      .run();
  }

  await resolveEmbeds(messageId, content, channelId, isDm, spaceId);
}

// ─── Batch Fetching ────────────────────────────────────────────────────────

export function fetchEmbedsForMessages(
  messageIds: string[],
): Map<string, (typeof schema.embeds.$inferSelect)[]> {
  const result = new Map<string, (typeof schema.embeds.$inferSelect)[]>();
  if (messageIds.length === 0) return result;

  const db = getDb();
  const rows = db.select()
    .from(schema.embeds)
    .where(inArray(schema.embeds.messageId, messageIds))
    .all();

  for (const row of rows) {
    if (!row.messageId) continue;
    const existing = result.get(row.messageId);
    if (existing) {
      existing.push(row);
    } else {
      result.set(row.messageId, [row]);
    }
  }

  return result;
}

export function fetchDmEmbedsForMessages(
  dmMessageIds: string[],
): Map<string, (typeof schema.embeds.$inferSelect)[]> {
  const result = new Map<string, (typeof schema.embeds.$inferSelect)[]>();
  if (dmMessageIds.length === 0) return result;

  const db = getDb();
  const rows = db.select()
    .from(schema.embeds)
    .where(inArray(schema.embeds.dmMessageId, dmMessageIds))
    .all();

  for (const row of rows) {
    if (!row.dmMessageId) continue;
    const existing = result.get(row.dmMessageId);
    if (existing) {
      existing.push(row);
    } else {
      result.set(row.dmMessageId, [row]);
    }
  }

  return result;
}
