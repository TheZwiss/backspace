import { eq, inArray } from 'drizzle-orm';
import type { Embed } from '@backspace/shared';
import { getDb, schema } from '../db/index.js';
import { generateSnowflake } from './snowflake.js';
import { classifyUrl } from './embedClassifier.js';
import { fetchUrlMetadata } from './metadataFetcher.js';
import { connectionManager } from '../ws/handler.js';

const MAX_EMBEDS_PER_MESSAGE = 5;

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

      // Track the effective embed type (may be overridden by Content-Type detection)
      let effectiveEmbedType = classification.embedType;

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
            title = metadata.title;
            description = metadata.description;
            image = metadata.image;
            siteName = metadata.siteName;
          }
        }

        // For generic embeds, skip if we couldn't extract a title and it's not a media URL
        if (effectiveEmbedType === 'generic' && !title) {
          continue;
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
        width: null,
        height: null,
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
