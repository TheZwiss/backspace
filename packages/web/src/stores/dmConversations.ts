import type { DmChannel, DmMessageWithUser } from '@backspace/shared';
import type { PeerDmChannel } from '../utils/dmConversationKey';

/**
 * The client's one DM merge module (ADR 0002, `docs/decisions/0002-dm-conversation-identity.md`).
 *
 * Federated DMs are mirrored on purpose: every instance that hosts a
 * participant keeps its own copy, so a client connected to several instances
 * receives one conversation under several channel ids. This module decides,
 * in one place, which copies are one conversation and which copy the client
 * shows. Pure functions, no store imports: `spaceStore` holds the state and
 * derives `dmChannels`, `dmAlternatives` and the DM entries of
 * `channelOriginMap` and `channelLastMessageIds` from it after every
 * operation.
 *
 * - A conversation is keyed by the key its copies share: `federatedId` when a
 *   server stated or the client derived one, otherwise `local:<origin>:<id>`,
 *   which matches no other copy.
 * - A copy remembers where its key came from (`DmKeySource`). Client state
 *   only, never on the wire.
 * - Each conversation pins one copy (the pin rule, `choosePin`), whose
 *   channel is the row the user sees and whose origin serves its messages.
 * - Every operation returns the next state and the pin moves it caused. A pin
 *   move is applied by one effect (`applyDmPinMoves` in
 *   `utils/dmOriginFailover.ts`): the chat state and the URL follow the row
 *   from its old channel id to its new one.
 */

/** Where a copy's key came from. */
export type DmKeySource =
  /** A server sent a string. */
  | 'stated'
  /**
   * A server sent `null`. Never derived, never folded into another copy. On a
   * current server this is a group no other instance holds; on an older one
   * it can also be an unkeyed 1-on-1.
   */
  | 'stated-null'
  /** Derived from the members for a peer on 1.6.1 or older (`deriveMissingOneOnOneKeys`). */
  | 'derived'
  /** No server has stated a key for this id yet. The next listing that contains the id replaces it. */
  | 'unknown';

/** One instance's copy of a conversation. `channel.federatedId` is the key this copy carries, or null. */
export interface DmCopy {
  readonly origin: string;
  readonly channel: DmChannel;
  readonly keySource: DmKeySource;
}

/** One conversation: at most one copy per origin, in the order the client learned them. */
export interface DmConversation {
  readonly key: string;
  readonly copies: ReadonlyMap<string, DmCopy>;
  readonly pinnedOrigin: string;
}

export interface DmConversations {
  readonly byKey: ReadonlyMap<string, DmConversation>;
  /** Origins whose socket dropped. A copy there is not pinned while another copy is reachable. */
  readonly unavailableOrigins: ReadonlySet<string>;
}

/** What the pin rule needs to know about the session. */
export interface DmPinContext {
  /** The user's home: `getLayoutHomeOrigin()`. */
  readonly home: string;
}

/** A row that moved from one channel id to another. */
export interface DmPinMove {
  readonly fromChannelId: string;
  readonly toChannelId: string;
  readonly toOrigin: string;
}

export interface DmOperation {
  readonly next: DmConversations;
  readonly pinMoves: readonly DmPinMove[];
}

export interface DmUpsert extends DmOperation {
  /** The channel id of the pinned copy of the conversation the copy joined: where the UI navigates. */
  readonly pinnedChannelId: string;
}

export const EMPTY_DM_CONVERSATIONS: DmConversations = {
  byKey: new Map(),
  unavailableOrigins: new Set(),
};

const LOCAL_KEY_PREFIX = 'local:';

function localKey(origin: string, channelId: string): string {
  return `${LOCAL_KEY_PREFIX}${origin}:${channelId}`;
}

function isLocalKey(key: string): boolean {
  return key.startsWith(LOCAL_KEY_PREFIX);
}

// ─── Mutable working copy ────────────────────────────────────────────────────

interface Draft {
  byKey: Map<string, { key: string; copies: Map<string, DmCopy>; pinnedOrigin: string | null }>;
  unavailable: Set<string>;
}

function draftOf(state: DmConversations): Draft {
  const byKey: Draft['byKey'] = new Map();
  for (const [key, conversation] of state.byKey) {
    byKey.set(key, { key, copies: new Map(conversation.copies), pinnedOrigin: conversation.pinnedOrigin });
  }
  return { byKey, unavailable: new Set(state.unavailableOrigins) };
}

/**
 * The pin rule: the copy of the user's home when it is present and connected;
 * else the current pin, if its copy is present and connected; else the first
 * connected copy in insertion order. A returning sibling never takes the pin
 * back. With no copy connected, the current pin stays, or the first copy.
 */
function choosePin(copies: ReadonlyMap<string, DmCopy>, current: string | null, home: string, unavailable: ReadonlySet<string>): string {
  const reachable = (origin: string): boolean => !unavailable.has(origin);
  if (copies.has(home) && reachable(home)) return home;
  if (current !== null && copies.has(current) && reachable(current)) return current;
  for (const origin of copies.keys()) {
    if (reachable(origin)) return origin;
  }
  if (current !== null && copies.has(current)) return current;
  const first = copies.keys().next();
  if (first.done) throw new Error('A DM conversation without copies has no pin');
  return first.value;
}

/** Drop emptied conversations, apply the pin rule to the rest, and freeze. */
function commit(draft: Draft, ctx: DmPinContext): DmConversations {
  const byKey = new Map<string, DmConversation>();
  for (const [key, conversation] of draft.byKey) {
    if (conversation.copies.size === 0) continue;
    const pinnedOrigin = choosePin(conversation.copies, conversation.pinnedOrigin, ctx.home, draft.unavailable);
    byKey.set(key, { key, copies: conversation.copies, pinnedOrigin });
  }
  return { byKey, unavailableOrigins: draft.unavailable };
}

function pinnedCopyOf(conversation: DmConversation): DmCopy {
  const copy = conversation.copies.get(conversation.pinnedOrigin);
  if (!copy) throw new Error(`DM conversation ${conversation.key} has no copy on its pinned origin`);
  return copy;
}

/**
 * Every row whose channel id changed: the old pinned id moves to the pinned
 * id of the conversation that now holds its copy, or, when that copy is gone,
 * of the conversation with its old key. A row whose conversation is gone
 * moves nowhere.
 */
function pinMovesBetween(before: DmConversations, after: DmConversations): DmPinMove[] {
  const moves: DmPinMove[] = [];
  for (const conversation of before.byKey.values()) {
    const fromChannelId = pinnedCopyOf(conversation).channel.id;
    const target = findCopy(after, fromChannelId)?.conversation ?? after.byKey.get(conversation.key);
    if (!target) continue;
    const pinned = pinnedCopyOf(target);
    if (pinned.channel.id === fromChannelId) continue;
    moves.push({ fromChannelId, toChannelId: pinned.channel.id, toOrigin: pinned.origin });
  }
  return moves;
}

function operation(before: DmConversations, draft: Draft, ctx: DmPinContext): DmOperation {
  const next = commit(draft, ctx);
  return { next, pinMoves: pinMovesBetween(before, next) };
}

/** Remove the copy `origin` holds under `channelId`, wherever it sits. Leaves emptied conversations for `commit`. */
function takeCopy(draft: Draft, origin: string, channelId: string): DmCopy | undefined {
  for (const conversation of draft.byKey.values()) {
    const copy = conversation.copies.get(origin);
    if (copy && copy.channel.id === channelId) {
      conversation.copies.delete(origin);
      return copy;
    }
  }
  return undefined;
}

/**
 * Place a copy under its key. At most one copy per key and origin: a second
 * copy from the same origin under one key keeps its own local key rather than
 * being dropped (a peer can hold two rows for one pair).
 */
function placeCopy(draft: Draft, copy: DmCopy): string {
  let key = copy.channel.federatedId ?? localKey(copy.origin, copy.channel.id);
  const existing = draft.byKey.get(key);
  if (existing && existing.copies.has(copy.origin) && existing.copies.get(copy.origin)?.channel.id !== copy.channel.id) {
    key = localKey(copy.origin, copy.channel.id);
  }
  let conversation = draft.byKey.get(key);
  if (!conversation) {
    conversation = { key, copies: new Map(), pinnedOrigin: null };
    draft.byKey.set(key, conversation);
  }
  conversation.copies.set(copy.origin, copy);
  return key;
}

// ─── Key completion (Decision 5) ─────────────────────────────────────────────

interface ResolvedKey {
  readonly federatedId: string | null;
  readonly keySource: DmKeySource;
}

/**
 * The key of a copy a server sent. A string is `stated`, `null` is
 * `stated-null`. An absent field (a peer on 1.6.1 or older) takes the key of
 * the previous copy with that origin and channel id, including its source,
 * unless that was `unknown`; else `derivedKey` when the caller has one; else
 * `unknown`.
 */
function resolveKey(sent: string | null | undefined, previous: DmCopy | undefined, derivedKey: string | undefined): ResolvedKey {
  if (typeof sent === 'string') return { federatedId: sent, keySource: 'stated' };
  if (sent === null) return { federatedId: null, keySource: 'stated-null' };
  if (previous && previous.keySource !== 'unknown') {
    return { federatedId: previous.channel.federatedId, keySource: previous.keySource };
  }
  if (derivedKey !== undefined) return { federatedId: derivedKey, keySource: 'derived' };
  return { federatedId: null, keySource: 'unknown' };
}

/** The value the server sent, else the previous copy's, else null. */
function sentOr<T>(sent: T | undefined, previous: T | undefined): T | null {
  if (sent !== undefined) return sent;
  return previous !== undefined ? previous : null;
}

/** A full channel from what a peer sent: absent fields take the previous copy's values. */
function completeChannel(sent: PeerDmChannel, previous: DmCopy | undefined, federatedId: string | null): DmChannel {
  const known = previous?.channel;
  return {
    ...sent,
    federatedId,
    ownerId: sentOr(sent.ownerId, known?.ownerId),
    ownerHomeUserId: sentOr(sent.ownerHomeUserId, known?.ownerHomeUserId),
    ownerHomeInstance: sentOr(sent.ownerHomeInstance, known?.ownerHomeInstance),
    name: sentOr(sent.name, known?.name),
    icon: sentOr(sent.icon, known?.icon),
    lastMessage: sentOr(sent.lastMessage, known?.lastMessage),
    metadataUpdatedAt: sent.metadataUpdatedAt ?? known?.metadataUpdatedAt ?? 0,
  };
}

/**
 * `completePeerListing`: the copies an origin's listing describes.
 *
 * 1. A field that is absent takes the value of the previous copy with that
 *    origin and channel id, the key's source included, unless that was
 *    `unknown`. A row the client saw in that origin's `ready` keeps what
 *    `ready` stated, `null` included.
 * 2. Still unknown: the derived key, when the caller derived one (a 1-on-1
 *    with a member homed elsewhere, in a secure context).
 * 3. A derived key shared by another entry of the same listing is dropped:
 *    the peer then holds two rows for one pair, and folding them would hide
 *    one of them.
 * 4. Otherwise `unknown`.
 */
function completePeerListing(
  origin: string,
  listed: readonly PeerDmChannel[],
  derivedKeys: ReadonlyMap<string, string>,
  previousById: ReadonlyMap<string, DmCopy>,
): DmCopy[] {
  const resolved = listed.map((sent) => {
    const previous = previousById.get(sent.id);
    return { sent, previous, key: resolveKey(sent.federatedId, previous, derivedKeys.get(sent.id)) };
  });
  const entriesPerKey = new Map<string, number>();
  for (const { key } of resolved) {
    if (key.federatedId !== null) entriesPerKey.set(key.federatedId, (entriesPerKey.get(key.federatedId) ?? 0) + 1);
  }
  return resolved.map(({ sent, previous, key }): DmCopy => {
    const shared = key.federatedId !== null && (entriesPerKey.get(key.federatedId) ?? 0) > 1;
    const final: ResolvedKey = key.keySource === 'derived' && shared ? { federatedId: null, keySource: 'unknown' } : key;
    return { origin, channel: completeChannel(sent, previous, final.federatedId), keySource: final.keySource };
  });
}

// ─── Operations ──────────────────────────────────────────────────────────────

/**
 * A `ready` payload or a `GET /api/dm` reload from `origin`: replaces every
 * copy from that origin. `derivedKeys` are the keys `deriveMissingOneOnOneKeys`
 * computed for entries without one (empty for `ready`, which always states
 * them). A listing proves the origin reachable.
 */
export function mergeOriginListing(
  state: DmConversations,
  origin: string,
  listed: readonly PeerDmChannel[],
  derivedKeys: ReadonlyMap<string, string>,
  ctx: DmPinContext,
): DmOperation {
  const draft = draftOf(state);
  const previousById = new Map<string, DmCopy>();
  for (const conversation of draft.byKey.values()) {
    const copy = conversation.copies.get(origin);
    if (!copy) continue;
    previousById.set(copy.channel.id, copy);
    conversation.copies.delete(origin);
  }
  for (const copy of completePeerListing(origin, listed, derivedKeys, previousById)) {
    placeCopy(draft, copy);
  }
  draft.unavailable.delete(origin);
  return operation(state, draft, ctx);
}

/**
 * One copy a server sent outside a listing: `dm_channel_created` or a create
 * response. `keySource` is `stated` for a channel a server sent (its
 * `federatedId` then says which source applies) and `unknown` for a
 * placeholder the client built.
 */
export function upsertCopy(
  state: DmConversations,
  origin: string,
  channel: PeerDmChannel,
  keySource: 'stated' | 'unknown',
  ctx: DmPinContext,
): DmUpsert {
  const draft = draftOf(state);
  const previous = takeCopy(draft, origin, channel.id);
  const key = keySource === 'unknown'
    ? resolveKey(undefined, previous, undefined)
    : resolveKey(channel.federatedId, previous, undefined);
  const copy: DmCopy = { origin, channel: completeChannel(channel, previous, key.federatedId), keySource: key.keySource };
  const placedKey = placeCopy(draft, copy);
  const result = operation(state, draft, ctx);
  const conversation = result.next.byKey.get(placedKey);
  const pinnedChannelId = conversation ? pinnedCopyOf(conversation).channel.id : channel.id;
  return { ...result, pinnedChannelId };
}

/**
 * The entry for a message no listing placed: a conversation of its own under
 * the origin that sent it, with an `unknown` key, the sender as its one known
 * member and the message as its preview. The next listing that contains the
 * id replaces it.
 */
export function upsertUnplacedCopy(
  state: DmConversations,
  origin: string,
  message: DmMessageWithUser,
  ctx: DmPinContext,
): DmUpsert {
  const placeholder: DmChannel = {
    id: message.dmChannelId,
    federatedId: null,
    ownerId: null,
    ownerHomeUserId: null,
    ownerHomeInstance: null,
    name: null,
    icon: null,
    metadataUpdatedAt: 0,
    createdAt: message.createdAt,
    members: message.user ? [message.user] : [],
    lastMessage: message,
  };
  return upsertCopy(state, origin, placeholder, 'unknown', ctx);
}

/**
 * `dm_channel_closed`, close and leave. Removing a conversation's pinned copy
 * removes the conversation, as closing its row always did; its other copies
 * come back through their origins' next listing or event. Removing any other
 * copy leaves the row as it is.
 */
export function removeCopy(state: DmConversations, channelId: string, ctx: DmPinContext): DmOperation {
  const found = findCopy(state, channelId);
  if (!found) return { next: state, pinMoves: [] };
  const draft = draftOf(state);
  if (found.conversation.pinnedOrigin === found.copy.origin) {
    draft.byKey.delete(found.conversation.key);
  } else {
    draft.byKey.get(found.conversation.key)?.copies.delete(found.copy.origin);
  }
  return operation(state, draft, ctx);
}

/**
 * Members, owner, metadata, last message: a change to the copy with that
 * channel id. Its id and key are not the patch's to change. Pins do not move.
 */
export function patchCopy(state: DmConversations, channelId: string, patch: (channel: DmChannel) => DmChannel): DmOperation {
  const found = findCopy(state, channelId);
  if (!found) return { next: state, pinMoves: [] };
  const copies = new Map(found.conversation.copies);
  copies.set(found.copy.origin, { ...found.copy, channel: patchedChannel(found.copy.channel, patch) });
  const byKey = new Map(state.byKey);
  byKey.set(found.conversation.key, { ...found.conversation, copies });
  return { next: { byKey, unavailableOrigins: state.unavailableOrigins }, pinMoves: [] };
}

/** A user update: `patch` applied to every copy. Pins do not move. */
/** `patch` gets each copy with the origin that issued it (its member rows are that origin's). */
export function patchEveryCopy(state: DmConversations, patch: (channel: DmChannel, origin: string) => DmChannel): DmOperation {
  let changed = false;
  const byKey = new Map<string, DmConversation>();
  for (const [key, conversation] of state.byKey) {
    const copies = new Map<string, DmCopy>();
    for (const [origin, copy] of conversation.copies) {
      const channel = patchedChannel(copy.channel, (c) => patch(c, origin));
      if (channel !== copy.channel) changed = true;
      copies.set(origin, channel === copy.channel ? copy : { ...copy, channel });
    }
    byKey.set(key, { ...conversation, copies });
  }
  if (!changed) return { next: state, pinMoves: [] };
  return { next: { byKey, unavailableOrigins: state.unavailableOrigins }, pinMoves: [] };
}

function patchedChannel(channel: DmChannel, patch: (channel: DmChannel) => DmChannel): DmChannel {
  const patched = patch(channel);
  if (patched === channel) return channel;
  return { ...patched, id: channel.id, federatedId: channel.federatedId };
}

/**
 * An origin's socket dropped (`available` false) or came back. Rows pinned
 * to a dropped origin move to a reachable copy by the pin rule (failover).
 */
export function setOriginAvailable(state: DmConversations, origin: string, available: boolean, ctx: DmPinContext): DmOperation {
  if (state.unavailableOrigins.has(origin) === !available) return { next: state, pinMoves: [] };
  const draft = draftOf(state);
  if (available) draft.unavailable.delete(origin);
  else draft.unavailable.add(origin);
  return operation(state, draft, ctx);
}

/** An instance was removed or disconnected by the user: its copies go, rows pinned there move or disappear. */
export function dropOrigin(state: DmConversations, origin: string, ctx: DmPinContext): DmOperation {
  const draft = draftOf(state);
  for (const conversation of draft.byKey.values()) conversation.copies.delete(origin);
  draft.unavailable.delete(origin);
  return operation(state, draft, ctx);
}

// ─── Views ───────────────────────────────────────────────────────────────────

/**
 * The pinned copy of each conversation, in conversation order (unsorted).
 * Its `federatedId` is the conversation's key, or null for a conversation
 * that has none, so every row's key says which copies it stands for.
 */
export function pinnedDmChannels(state: DmConversations): DmChannel[] {
  const rows: DmChannel[] = [];
  for (const conversation of state.byKey.values()) {
    const { channel } = pinnedCopyOf(conversation);
    const federatedId = isLocalKey(conversation.key) ? null : conversation.key;
    rows.push(channel.federatedId === federatedId ? channel : { ...channel, federatedId });
  }
  return rows;
}

/** Pinned channel id → the origin serving it. */
export function pinnedOriginByChannelId(state: DmConversations): Map<string, string> {
  const origins = new Map<string, string>();
  for (const conversation of state.byKey.values()) {
    origins.set(pinnedCopyOf(conversation).channel.id, conversation.pinnedOrigin);
  }
  return origins;
}

/**
 * Conversation key → (origin → that origin's channel id), for every
 * conversation that has a key: the index `resolveDmChannelId` reads (the
 * store's `dmAlternatives`). Every copy is in it, the pinned one included.
 */
export function conversationCopyIndex(state: DmConversations): Map<string, Map<string, string>> {
  const index = new Map<string, Map<string, string>>();
  for (const conversation of state.byKey.values()) {
    if (isLocalKey(conversation.key)) continue;
    const byOrigin = new Map<string, string>();
    for (const [origin, copy] of conversation.copies) byOrigin.set(origin, copy.channel.id);
    index.set(conversation.key, byOrigin);
  }
  return index;
}

/** The copy with this channel id and its conversation, or null. */
export function findCopy(state: DmConversations, channelId: string): { conversation: DmConversation; copy: DmCopy } | null {
  for (const conversation of state.byKey.values()) {
    for (const copy of conversation.copies.values()) {
      if (copy.channel.id === channelId) return { conversation, copy };
    }
  }
  return null;
}

/**
 * The copy `origin` holds of the conversation of `channelId`, or null when
 * that origin holds no copy of it. A request to an instance names the
 * conversation, and its members, as that instance's own copy does.
 */
export function copyOnOrigin(state: DmConversations, channelId: string, origin: string): DmChannel | null {
  const found = findCopy(state, channelId);
  return found?.conversation.copies.get(origin)?.channel ?? null;
}

/** The channel id of `copyOnOrigin`, or null. */
export function copyIdOnOrigin(state: DmConversations, channelId: string, origin: string): string | null {
  return copyOnOrigin(state, channelId, origin)?.id ?? null;
}
