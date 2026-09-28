import { eq } from 'drizzle-orm';
import type { FederationMentionRef } from '@backspace/shared';
import { getDb, schema } from '../db/index.js';
import { relayActorOfUser, resolveRelayActor } from '../routes/federation/identity.js';

/**
 * Mentions in relayed DM content (#347).
 *
 * A `<@id>` token carries an id issued by the instance the content was written
 * on. The relay carries the content together with `message.mentions`, which
 * names each mentioned id's federated identity, and the receiver rewrites the
 * tokens to its own rows for those identities. The rule is written down in
 * docs/systems/dm-system.md, "Mentions in relayed messages".
 */

/** The most mentions a relayed message carries, and the most a receiver reads. */
export const MAX_RELAYED_MENTIONS = 100;

/** Longest `id` / `homeUserId` / `homeInstance` a receiver accepts in an entry. */
const MAX_FIELD_LENGTH = 255;

const MENTION_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * Code spans (fenced, then inline) or a mention token. Code spans are matched
 * so they can be skipped: the client renders a token as a mention only outside
 * code, the same scan as `MarkdownRenderer`'s mention pass in the web package.
 */
function mentionScanner(): RegExp {
  return /(```[\s\S]*?```|`[^`]+`)|<@([a-zA-Z0-9_-]+)>/g;
}

/** The ids of the mention tokens in `content` outside code, once each, in order. */
export function mentionTokenIds(content: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(mentionScanner())) {
    const id = match[2];
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * `content` with every token outside code whose id is a key of `localIds`
 * rewritten to the mapped id. Everything else is left as written.
 */
export function replaceMentionTokens(content: string, localIds: ReadonlyMap<string, string>): string {
  return content.replace(mentionScanner(), (whole: string, code: string | undefined, id: string | undefined) => {
    if (code !== undefined || id === undefined) return whole;
    const local = localIds.get(id);
    return local === undefined ? whole : `<@${local}>`;
  });
}

/**
 * Sender side: the `mentions` list a relayed message carries, or undefined
 * when it carries none. Every relay builder spreads this one value, so the
 * rule lives here: a system message carries no list (its content is not text
 * with tokens), and neither does content with no resolvable mention.
 *
 * Each token id that names a live user row here becomes an entry with that
 * row's federated identity (`relayActorOfUser`): a native row is its own id on
 * this instance, a replicated or federated row its home pair. Ids that name
 * no live row, or a row without a comparable identity, are left out; the
 * token then reaches the receiver as written.
 */
export function relayMentionsOf(
  message: { type?: string | null; content: string | null },
  db: ReturnType<typeof getDb> = getDb(),
): FederationMentionRef[] | undefined {
  const { content } = message;
  if (message.type === 'system' || !content) return undefined;
  const mentions: FederationMentionRef[] = [];
  for (const id of mentionTokenIds(content)) {
    if (mentions.length >= MAX_RELAYED_MENTIONS) break;
    const row = db
      .select({
        id: schema.users.id,
        homeUserId: schema.users.homeUserId,
        homeInstance: schema.users.homeInstance,
        isDeleted: schema.users.isDeleted,
      })
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .get();
    if (!row || row.isDeleted) continue;
    const identity = relayActorOfUser(row);
    if (!identity) continue;
    mentions.push({ id, homeUserId: identity.homeUserId, homeInstance: identity.homeInstance });
  }
  return mentions.length > 0 ? mentions : undefined;
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

/**
 * The well-formed entries of a relayed `mentions` value: at most
 * `MAX_RELAYED_MENTIONS` of them read, each with a token-shaped `id` and
 * bounded string fields, and only the first entry for an id.
 */
function readRelayedMentions(raw: unknown): Map<string, FederationMentionRef> {
  const byId = new Map<string, FederationMentionRef>();
  if (!Array.isArray(raw)) return byId;
  for (const entry of raw.slice(0, MAX_RELAYED_MENTIONS) as unknown[]) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, homeUserId, homeInstance } = entry as Record<string, unknown>;
    if (!isBoundedString(id) || !MENTION_ID.test(id)) continue;
    if (!isBoundedString(homeUserId) || !isBoundedString(homeInstance)) continue;
    if (byId.has(id)) continue;
    byId.set(id, { id, homeUserId, homeInstance });
  }
  return byId;
}

/**
 * Receiver side: relayed `content` with its mention tokens naming this
 * instance's rows. Each token whose id the list names is rewritten to the
 * live local user that IS the listed identity (`resolveRelayActor`: matched on
 * home user id + home instance, never on the bare id). A token the list does
 * not name, or whose identity has no live row here, is kept as written; no
 * row is created for a mention. Without a list (an older sender) the content
 * is returned unchanged.
 */
export function rewriteRelayedMentions(
  content: string | null,
  rawMentions: unknown,
  db: ReturnType<typeof getDb>,
): string | null {
  if (!content || rawMentions === undefined) return content;
  const listed = readRelayedMentions(rawMentions);
  if (listed.size === 0) return content;

  const localIds = new Map<string, string>();
  for (const id of mentionTokenIds(content)) {
    const mention = listed.get(id);
    if (!mention) continue;
    const resolved = resolveRelayActor({ homeUserId: mention.homeUserId, homeInstance: mention.homeInstance }, db);
    if (resolved.kind === 'found') localIds.set(id, resolved.user.id);
  }
  return localIds.size === 0 ? content : replaceMentionTokens(content, localIds);
}
