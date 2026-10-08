import { and, eq } from 'drizzle-orm';
import { MAX_MESSAGE_LENGTH } from '@backspace/shared';
import type { ErrorCode, ErrorDetails } from '@backspace/shared/src/errors';
import { getDb, schema } from '../db/index.js';
import { isDeadOneOnOne, isDmMember } from './permissions.js';
import { dmMessageEditRefusal } from './dmSystemMessages.js';

/**
 * The rules for creating, editing and deleting a DM message, in one place.
 *
 * The REST routes (`routes/dm.ts`) and the WebSocket events (`ws/events.ts`)
 * both ask these checks, in the same order, so the two paths cannot drift
 * apart. A check answers with the normalized input or the row the caller
 * goes on with, or with a refusal: the error code, its details, and the HTTP
 * status the REST path answers with. The WebSocket path sends the code and
 * details in an `error` event.
 *
 * Identity: every id here is a row id on this instance. The session's user
 * row and the conversation's member rows live in the same table, so a
 * federated account acting here, or a replicated partner whose home deleted
 * them (tombstoned here by the identity delete), is judged by its own row.
 *
 * Membership: all three checks ask `isDmMember` against this instance's copy
 * of the conversation. A member who left or was removed from a group no
 * longer has a row there, so they can neither post nor edit or delete what
 * they wrote before leaving. A member who closed a conversation keeps the
 * row and keeps those rights.
 */

export interface DmMessageRefusal {
  status: 400 | 403 | 404;
  code: ErrorCode;
  details?: ErrorDetails;
}

export type DmMessageCheck<T> = { ok: true; value: T } | { ok: false; refusal: DmMessageRefusal };

type DmMessageRow = typeof schema.dmMessages.$inferSelect;

/** What a create carries once it has passed the checks. */
export interface DmMessageCreateInput {
  /** Trimmed text, or null for an attachment-only message. */
  content: string | null;
  attachmentIds: string[];
  replyToId: string | null;
}

/** The raw fields of a create, as a request body or a WebSocket event holds them. */
export interface DmMessageCreateFields {
  content?: unknown;
  attachments?: unknown;
  replyToId?: unknown;
}

function refuse<T>(status: DmMessageRefusal['status'], code: ErrorCode, details?: ErrorDetails): DmMessageCheck<T> {
  return { ok: false, refusal: details ? { status, code, details } : { status, code } };
}

/**
 * True when `replyToId` names an existing message inside `dmChannelId`, so a
 * reply can only point at the conversation it is posted into.
 */
export function isDmReplyTargetInChannel(dmChannelId: string, replyToId: string): boolean {
  const db = getDb();
  const target = db.select({ id: schema.dmMessages.id })
    .from(schema.dmMessages)
    .where(and(
      eq(schema.dmMessages.id, replyToId),
      eq(schema.dmMessages.dmChannelId, dmChannelId),
    ))
    .get();
  return target !== undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * May `userId` post a message with `fields` into `dmChannelId`?
 *
 * Order: membership, the read-only rule for a 1-on-1 whose partner was
 * deleted (`recipient_deleted`), the shape of the fields, content, the reply
 * target, then each attachment (unlinked and uploaded by the sender).
 */
export function checkDmMessageCreate(
  dmChannelId: string,
  userId: string,
  fields: DmMessageCreateFields,
): DmMessageCheck<DmMessageCreateInput> {
  if (!isDmMember(dmChannelId, userId)) return refuse(403, 'not_dm_member');
  if (isDeadOneOnOne(dmChannelId, userId)) return refuse(403, 'recipient_deleted');

  const { content, attachments, replyToId } = fields;
  if (content !== undefined && content !== null && typeof content !== 'string') return refuse(400, 'validation_failed');
  if (attachments !== undefined && attachments !== null && !isStringArray(attachments)) return refuse(400, 'validation_failed');
  if (replyToId !== undefined && replyToId !== null && typeof replyToId !== 'string') return refuse(400, 'validation_failed');

  const text = typeof content === 'string' ? content.trim() : '';
  const attachmentIds = attachments ?? [];
  if (text.length === 0 && attachmentIds.length === 0) return refuse(400, 'content_required');
  if (typeof content === 'string' && content.length > MAX_MESSAGE_LENGTH) {
    return refuse(400, 'content_too_long', { max: MAX_MESSAGE_LENGTH });
  }

  const reply = replyToId || null;
  if (reply && !isDmReplyTargetInChannel(dmChannelId, reply)) return refuse(400, 'reply_target_invalid');

  const db = getDb();
  for (const attId of attachmentIds) {
    const att = db.select().from(schema.attachments).where(eq(schema.attachments.id, attId)).get();
    if (!att || att.messageId || att.dmMessageId) return refuse(400, 'attachment_invalid');
    if (att.uploaderId && att.uploaderId !== userId) return refuse(400, 'attachment_not_owned');
  }

  return { ok: true, value: { content: text.length > 0 ? text : null, attachmentIds, replyToId: reply } };
}

/**
 * May `editorId` replace the text of DM message `messageId` with `content`?
 *
 * Order: content, the message exists, membership of the message's
 * conversation (`not_dm_member`), `dmMessageEditRefusal` (a system message
 * cannot be edited, any other only by its author), then the read-only rule.
 * On success the value carries the row and the trimmed text.
 */
export function checkDmMessageEdit(
  messageId: string,
  editorId: string,
  content: unknown,
): DmMessageCheck<{ message: DmMessageRow; content: string }> {
  if (typeof content !== 'string' || content.trim().length === 0) return refuse(400, 'content_required');
  if (content.length > MAX_MESSAGE_LENGTH) return refuse(400, 'content_too_long', { max: MAX_MESSAGE_LENGTH });

  const message = getDb().select().from(schema.dmMessages).where(eq(schema.dmMessages.id, messageId)).get();
  if (!message) return refuse(404, 'message_not_found');
  if (!isDmMember(message.dmChannelId, editorId)) return refuse(403, 'not_dm_member');

  const editRefusal = dmMessageEditRefusal(message, editorId);
  if (editRefusal) return refuse(403, editRefusal);

  if (isDeadOneOnOne(message.dmChannelId, editorId)) return refuse(403, 'recipient_deleted');

  return { ok: true, value: { message, content: content.trim() } };
}

/**
 * May `userId` delete DM message `messageId`?
 *
 * Order: the message exists, membership of the message's conversation
 * (`not_dm_member`), the user wrote it (there is no moderation delete in
 * DMs), then the read-only rule. On success the value is the row.
 */
export function checkDmMessageDelete(messageId: string, userId: string): DmMessageCheck<DmMessageRow> {
  const message = getDb().select().from(schema.dmMessages).where(eq(schema.dmMessages.id, messageId)).get();
  if (!message) return refuse(404, 'message_not_found');
  if (!isDmMember(message.dmChannelId, userId)) return refuse(403, 'not_dm_member');
  if (message.userId !== userId) return refuse(403, 'not_message_author');
  if (isDeadOneOnOne(message.dmChannelId, userId)) return refuse(403, 'recipient_deleted');
  return { ok: true, value: message };
}
