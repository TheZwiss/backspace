import type Database from 'better-sqlite3';
import { and, asc, eq, inArray, isNull, lt, lte, notExists, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { FederationRelayEvent } from '@backspace/shared';
import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { generateSnowflake } from './snowflake.js';

// ─── The outbox queue model ─────────────────────────────────────────────────
//
// The outbox holds, per peer, one queue per entity (`queue_key`): the events
// of one message, one reaction, one user's presence, one friendship, one
// group's membership. A queue is sent one row at a time, oldest first (the
// worker only picks a queue's head), so a peer applies an entity's events in
// the order they happened.
//
// A newer event is folded into what is queued only where the fold is right
// whatever the peer already holds. Whether it may hold a row is recorded in
// `offered_at`, set before any path can hand the row over: the worker before
// its POST, the `/sync` handler when the peer pulls the mutation log. A row
// that has been offered is never changed again; it is only deleted (settled,
// replaced or expired) or has its backoff moved. A replacement is a new row,
// so the worker settling the offered row by id can never touch it.
//
// See docs/systems/federation.md, "Outbox queues".

/** Relay events that travel through the outbox. Calls and typing are sent directly. */
export type OutboxEventType = Exclude<
  FederationRelayEvent['eventType'],
  'dm_call_start' | 'dm_call_accept' | 'dm_call_reject' | 'dm_call_end' | 'dm_typing_start' | 'dm_typing_stop'
>;

/**
 * How a family folds a newer event into its queue:
 * - `state`: the newer event sets the whole state the peer holds for the
 *   entity, so it replaces everything queued for it, offered or not.
 * - `message`: a DM message's create, update and delete. See `planMessageWrite`.
 * - `event`: each event is its own fact; it is appended and sent in turn.
 */
type OutboxFamily = 'state' | 'message' | 'event';

interface OutboxEventRule {
  family: OutboxFamily;
  /** The entity the event belongs to. Prefixed per family, so two families can never share a queue. */
  queueKey: (entityId: string, contextId: string, payload: unknown) => string;
  /** A refusal for good ends the entity at the peer, so what is queued behind it is dropped too. */
  refusalEndsQueue: boolean;
}

/** A string at `path` in a parsed payload, or null. */
function payloadString(payload: unknown, ...path: string[]): string | null {
  let node: unknown = payload;
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return null;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'string' && node.length > 0 ? node : null;
}

const messageRule: OutboxEventRule = {
  family: 'message',
  queueKey: (entityId) => `message:${entityId}`,
  refusalEndsQueue: false,
};

/**
 * One user's reaction with one emoji on one message. The add goes out under
 * the reaction's id and the remove under `msg:user:emoji`, so the queue is
 * named from the payload both carry.
 */
const reactionRule: OutboxEventRule = {
  family: 'state',
  queueKey: (entityId, _contextId, payload) => {
    const messageId = payloadString(payload, 'reaction', 'messageId');
    const home = payloadString(payload, 'reaction', 'messageHomeInstance');
    const userId = payloadString(payload, 'reaction', 'userId');
    const emoji = payloadString(payload, 'reaction', 'emoji');
    return messageId && home && userId && emoji
      ? `reaction:${home}:${messageId}:${userId}:${emoji}`
      : `reaction:${entityId}`;
  },
  refusalEndsQueue: false,
};

/** Whether one user has one conversation closed: close and reopen share the queue. */
const dmOpenStateRule: OutboxEventRule = {
  family: 'state',
  queueKey: (entityId, _contextId, payload) => {
    const federatedId = payloadString(payload, 'federatedId');
    const homeUserId = payloadString(payload, 'dmCloseReopen', 'homeUserId');
    const homeInstance = payloadString(payload, 'dmCloseReopen', 'homeInstance');
    return federatedId && homeUserId && homeInstance
      ? `dm_open:${federatedId}:${homeInstance}:${homeUserId}`
      : `dm_open:${entityId}`;
  },
  refusalEndsQueue: false,
};

/** Every event of one friendship, in order: its context id names the pair. */
const friendshipRule: OutboxEventRule = {
  family: 'event',
  queueKey: (_entityId, contextId) => `friendship:${contextId}`,
  refusalEndsQueue: false,
};

/** Every membership, ownership and metadata change of one group DM, in order. */
const groupRule: OutboxEventRule = {
  family: 'event',
  queueKey: (_entityId, contextId, payload) => `group:${payloadString(payload, 'federatedId') ?? contextId}`,
  refusalEndsQueue: false,
};

const OUTBOX_EVENT_RULES: Record<OutboxEventType, OutboxEventRule> = {
  create: { ...messageRule, refusalEndsQueue: true },
  update: messageRule,
  delete: messageRule,
  reaction_add: reactionRule,
  reaction_remove: reactionRule,
  presence_update: {
    family: 'state',
    queueKey: (entityId) => `presence:${entityId}`,
    refusalEndsQueue: false,
  },
  profile_update: {
    family: 'state',
    queueKey: (entityId) => `profile:${entityId}`,
    refusalEndsQueue: false,
  },
  read_state_update: {
    family: 'state',
    queueKey: (entityId, _contextId, payload) => {
      const federatedId = payloadString(payload, 'federatedId');
      const homeUserId = payloadString(payload, 'readState', 'user', 'homeUserId');
      const homeInstance = payloadString(payload, 'readState', 'user', 'homeInstance');
      return federatedId && homeUserId && homeInstance
        ? `read_state:${federatedId}:${homeInstance}:${homeUserId}`
        : `read_state:${entityId}`;
    },
    refusalEndsQueue: false,
  },
  dm_close: dmOpenStateRule,
  dm_reopen: dmOpenStateRule,
  file_rejected: {
    // One queue per rejected attachment: the peer knows every rejection of a
    // message by the message's id, but each is a separate fact.
    family: 'event',
    queueKey: (entityId, _contextId, payload) => `file_rejected:${entityId}:${payloadString(payload, 'attachmentId') ?? ''}`,
    refusalEndsQueue: false,
  },
  friend_request_create: friendshipRule,
  friend_request_update: friendshipRule,
  friend_request_cancel: friendshipRule,
  friend_add: friendshipRule,
  friend_remove: friendshipRule,
  member_add: groupRule,
  member_remove: groupRule,
  ownership_transfer: groupRule,
  group_metadata_update: groupRule,
};

function isOutboxEventType(eventType: string): eventType is OutboxEventType {
  return Object.prototype.hasOwnProperty.call(OUTBOX_EVENT_RULES, eventType);
}

function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

/** The queue an event belongs to. See OUTBOX_EVENT_RULES. */
export function outboxQueueKey(eventType: OutboxEventType, entityId: string, contextId: string, payload: string): string {
  return OUTBOX_EVENT_RULES[eventType].queueKey(entityId, contextId, parsePayload(payload));
}

/** Whether a refusal for good of this event drops the rest of its queue (a create: the peer will never hold the message). */
export function refusalEndsOutboxQueue(eventType: string): boolean {
  return isOutboxEventType(eventType) && OUTBOX_EVENT_RULES[eventType].refusalEndsQueue;
}

/** The event types whose rows each set the whole state of their entity. */
const STATE_EVENT_TYPES = (Object.keys(OUTBOX_EVENT_RULES) as OutboxEventType[])
  .filter((eventType) => OUTBOX_EVENT_RULES[eventType].family === 'state');

// ─── Writing an event into its queue ────────────────────────────────────────

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

interface QueuedRow {
  id: string;
  eventType: string;
  offeredAt: number | null;
  createdAt: number;
}

/**
 * What writing a newer event does to its queue:
 * - `append`: insert it as a new row after `remove` are deleted;
 * - `absorb`: carry its payload in `rowId`, a create no path has offered;
 * - `cancel`: delete `remove` and insert nothing.
 */
type QueuePlan =
  | { kind: 'append'; remove: string[] }
  | { kind: 'absorb'; rowId: string }
  | { kind: 'cancel'; remove: string[] };

/**
 * A DM message's queue. A create no path has offered is the only row the
 * peer is known not to hold, so it is the only one an edit may be folded into
 * and the only one a delete may cancel. Every other fold is one where the
 * newer event is right whatever the peer holds: an edit replaces a queued
 * edit, and a delete replaces everything queued (a delete for a message the
 * peer never got is settled at the peer).
 */
function planMessageWrite(eventType: OutboxEventType, queued: QueuedRow[]): QueuePlan {
  const tail = queued[queued.length - 1];
  if (eventType === 'delete') {
    const unofferedCreate = queued.some((row) => row.eventType === 'create' && row.offeredAt === null);
    const remove = queued.map((row) => row.id);
    return unofferedCreate ? { kind: 'cancel', remove } : { kind: 'append', remove };
  }
  if (eventType === 'update' && tail) {
    if (tail.eventType === 'create' && tail.offeredAt === null) return { kind: 'absorb', rowId: tail.id };
    if (tail.eventType === 'update') return { kind: 'append', remove: [tail.id] };
  }
  return { kind: 'append', remove: [] };
}

function planQueueWrite(eventType: OutboxEventType, queued: QueuedRow[]): QueuePlan {
  switch (OUTBOX_EVENT_RULES[eventType].family) {
    case 'state':
      return { kind: 'append', remove: queued.map((row) => row.id) };
    case 'message':
      return planMessageWrite(eventType, queued);
    case 'event':
      return { kind: 'append', remove: [] };
  }
}

export interface OutboxEventInput {
  peerId: string;
  contextId: string;
  contextType: string;
  /** The id the peer knows the event by. */
  entityId: string;
  eventType: OutboxEventType;
  payload: string;
  expiresAt: number;
}

/**
 * Write one event into its peer's queue, by the rules above. Run inside the
 * caller's transaction. A new row is due now and stamped later than every row
 * of its queue, so it is sent after them and a receiver that keeps the
 * newest timestamp sees it as newer.
 */
export function writeOutboxEvent(tx: Tx, input: OutboxEventInput, now: number): void {
  const queueKey = outboxQueueKey(input.eventType, input.entityId, input.contextId, input.payload);
  const queued: QueuedRow[] = tx
    .select({
      id: schema.federationOutbox.id,
      eventType: schema.federationOutbox.eventType,
      offeredAt: schema.federationOutbox.offeredAt,
      createdAt: schema.federationOutbox.createdAt,
    })
    .from(schema.federationOutbox)
    .where(and(
      eq(schema.federationOutbox.peerId, input.peerId),
      eq(schema.federationOutbox.queueKey, queueKey),
    ))
    .orderBy(asc(schema.federationOutbox.createdAt), asc(schema.federationOutbox.id))
    .all();

  const plan = planQueueWrite(input.eventType, queued);

  if (plan.kind === 'absorb') {
    tx.update(schema.federationOutbox)
      .set({ payload: input.payload })
      .where(eq(schema.federationOutbox.id, plan.rowId))
      .run();
    return;
  }

  if (plan.remove.length > 0) {
    tx.delete(schema.federationOutbox)
      .where(inArray(schema.federationOutbox.id, plan.remove))
      .run();
  }
  if (plan.kind === 'cancel') return;

  const latest = queued.reduce((max, row) => Math.max(max, row.createdAt), 0);
  tx.insert(schema.federationOutbox)
    .values({
      id: generateSnowflake(),
      peerId: input.peerId,
      contextId: input.contextId,
      entityId: input.entityId,
      queueKey,
      contextType: input.contextType,
      eventType: input.eventType,
      payload: input.payload,
      encryptionVersion: 0,
      attempts: 0,
      nextRetryAt: now,
      expiresAt: input.expiresAt,
      createdAt: Math.max(now, latest + 1),
      offeredAt: null,
    })
    .run();
}

// ─── Offering ───────────────────────────────────────────────────────────────

/** The worker is about to put these rows on the wire. Run before the request leaves. */
export function markOutboxOffered(db: Pick<Tx, 'update'>, outboxIds: readonly string[], now: number): void {
  if (outboxIds.length === 0) return;
  db.update(schema.federationOutbox)
    .set({ offeredAt: sql`coalesce(${schema.federationOutbox.offeredAt}, ${now})` })
    .where(inArray(schema.federationOutbox.id, [...outboxIds]))
    .run();
}

/**
 * `peerId` is pulling our mutation log (`/api/federation/sync`), which may
 * carry what is queued for it: mark its rows of `contextType` queued up to
 * `upTo` as offered.
 */
export function markOutboxOfferedForPeer(peerId: string, upTo: number, contextType: 'dm' | 'friend' | 'profile'): void {
  getDb().update(schema.federationOutbox)
    .set({ offeredAt: sql`coalesce(${schema.federationOutbox.offeredAt}, ${upTo})` })
    .where(and(
      eq(schema.federationOutbox.peerId, peerId),
      eq(schema.federationOutbox.contextType, contextType),
      lte(schema.federationOutbox.createdAt, upTo),
    ))
    .run();
}

// ─── Queue heads and expiry ─────────────────────────────────────────────────

/**
 * SQL condition: the outbox row is the head of its queue (no older row of the
 * same peer and key). A row without a key (queued before keys existed, until
 * the boot backfill) is its own queue.
 */
export function isOutboxQueueHead(): SQL {
  const earlier = alias(schema.federationOutbox, 'earlier');
  const row = schema.federationOutbox;
  return or(
    isNull(row.queueKey),
    notExists(
      getDb().select({ one: sql`1` })
        .from(earlier)
        .where(and(
          eq(earlier.peerId, row.peerId),
          eq(earlier.queueKey, row.queueKey),
          or(
            lt(earlier.createdAt, row.createdAt),
            and(eq(earlier.createdAt, row.createdAt), lt(earlier.id, row.id)),
          ),
        )),
    ),
  )!;
}

/**
 * Delete rows past their relay TTL, by queue: an expired row takes every row
 * queued behind it in its queue with it, since those change something the peer
 * may never have got. A state row behind it is kept: it carries the entity's
 * whole state on its own. Returns the number of rows removed.
 */
export function expireOutboxQueues(now: number): number {
  const stateTypes = sql.join(STATE_EVENT_TYPES.map((eventType) => sql`${eventType}`), sql`, `);
  const result = getDb().run(sql`
    DELETE FROM federation_outbox WHERE id IN (
      SELECT o.id FROM federation_outbox o
      WHERE EXISTS (
        SELECT 1 FROM federation_outbox e
        WHERE e.expires_at < ${now}
          AND e.peer_id = o.peer_id
          AND (
            e.id = o.id
            OR (
              e.queue_key = o.queue_key
              AND o.event_type NOT IN (${stateTypes})
              AND (e.created_at < o.created_at OR (e.created_at = o.created_at AND e.id < o.id))
            )
          )
      )
    )
  `);
  return result.changes;
}

// ─── Boot backfill ──────────────────────────────────────────────────────────

/**
 * Give every row queued before `queue_key` existed the key its event gets
 * today. Idempotent; returns the number of rows keyed. Rows of an event type
 * the outbox no longer queues keep a key of their own.
 */
export function backfillOutboxQueueKeys(sqlite: Database.Database): number {
  const unkeyed = sqlite.prepare(
    'SELECT id, entity_id AS entityId, context_id AS contextId, event_type AS eventType, payload FROM federation_outbox WHERE queue_key IS NULL',
  ).all() as Array<{ id: string; entityId: string; contextId: string; eventType: string; payload: string }>;
  if (unkeyed.length === 0) return 0;

  const setKey = sqlite.prepare('UPDATE federation_outbox SET queue_key = ? WHERE id = ?');
  sqlite.transaction(() => {
    for (const row of unkeyed) {
      const key = isOutboxEventType(row.eventType)
        ? outboxQueueKey(row.eventType, row.entityId, row.contextId, row.payload)
        : `unknown:${row.id}`;
      setKey.run(key, row.id);
    }
  })();
  console.log(`[federation-outbox] Keyed ${unkeyed.length} outbox row(s) queued before queue keys existed`);
  return unkeyed.length;
}
