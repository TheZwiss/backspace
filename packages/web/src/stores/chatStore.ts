import { create } from 'zustand';
import type { MessageWithUser, Reaction, ReadState, User } from '@backspace/shared';
import { wsSend } from '../hooks/useWebSocket';
import { HttpError } from '../api/client';
import { isDmChannel, getChannelOrigin, getApiForOrigin, useSpaceStore } from './spaceStore';
import { isMe, myRowForOrigin } from './authStore';
import { normalizeMessageAssets } from '../utils/assetUrls';
import { updateIsAboutRowId, withUserUpdate, type IdentityFields } from '../utils/identity';
import { usePendingMessageStore } from './pendingMessageStore';
import type { ScrollAnchor } from '../components/chat/scrollAnchor';

const MAX_MESSAGES_PER_CHANNEL = 200;

// Page size of every history request: the newest page, older pages and newer
// pages. A page shorter than this reached the end of history on its side.
const HISTORY_PAGE_LIMIT = 50;

// Window size for `loadMessagesAround`. The server returns up to half of it
// on each side of the target (docs/systems/search.md, "Messages-Around
// Endpoint"), so fewer than `half` newer messages means the window reaches
// the newest message in the channel.
const MESSAGES_AROUND_LIMIT = 50;

/**
 * Outcome of `loadMessagesAround`. `not_found` is the target missing on the
 * channel's origin (deleted, or an id that instance never had); `failed` is
 * anything else (network, permission, server error).
 */
export type LoadAroundResult = 'loaded' | 'not_found' | 'failed';

/**
 * A channel's newest-page load (`loadMessages`), per channel. `waiting`: the
 * channel is unknown (`getChannelKind`), so nothing can be asked yet: its
 * origin and endpoint depend on what it is. It ends when a listing names the
 * channel and `loadMessages` runs again (the open `MessageList` asks as soon
 * as the kind is known). `loading`: in flight. `failed`: the request ended on
 * `error`. No entry means idle.
 */
export type ChannelLoadState =
  | { status: 'waiting' }
  | { status: 'loading' }
  | { status: 'failed'; error: unknown };

/**
 * Outcome of `loadNewerMessages`, which pages a detached window forward.
 * `paged`: the page was appended and the window is still short of the
 * newest message. `attached`: the window reached the newest message.
 * `present`: the channel's origin predates forward paging and answered with
 * its newest page, which replaced the window as a return to the present.
 * `skipped`: nothing to do (the channel is not detached, or its window was
 * replaced while the page loaded). `failed`: the request failed.
 */
export type LoadNewerResult = 'paged' | 'attached' | 'present' | 'skipped' | 'failed';

/** True for ids the server issued; optimistic sends carry `temp_…` ids. */
function isServerId(id: string): boolean {
  return /^\d+$/.test(id);
}

/**
 * The greatest server id among `messages`. Ids are compared as numbers, not
 * by position: a relayed message keeps its sender's `createdAt` but gets a
 * local id, so it can sit earlier in the list than its id says.
 */
function greatestServerId(messages: readonly MessageWithUser[]): string | null {
  let greatest: string | null = null;
  for (const message of messages) {
    if (!isServerId(message.id)) continue;
    if (greatest === null || BigInt(message.id) > BigInt(greatest)) greatest = message.id;
  }
  return greatest;
}

/**
 * `messages` followed by the held live messages newer than all of them: the
 * ones that arrived while the window was detached and that the page now
 * reaching the present does not hold yet.
 */
function withHeldMessages(messages: MessageWithUser[], held: readonly MessageWithUser[] | undefined): MessageWithUser[] {
  if (!held || held.length === 0) return messages;
  const greatest = greatestServerId(messages);
  const present = new Set(messages.map((m) => m.id));
  const newer = held.filter((m) => !present.has(m.id) && (greatest === null || BigInt(m.id) > BigInt(greatest)));
  return newer.length > 0 ? [...messages, ...newer] : messages;
}

/**
 * The optimistic sends in `previous` that `page` does not answer yet. A send
 * whose message is already in the page is dropped by the same content match
 * `addRealtimeMessage` uses, so a reload never leaves an optimistic twin.
 */
function unconfirmedSends(previous: readonly MessageWithUser[] | undefined, page: readonly MessageWithUser[]): MessageWithUser[] {
  if (!previous) return [];
  const temps = previous.filter((m) => m.id.startsWith('temp_'));
  if (temps.length === 0) return temps;
  const contents = new Set(page.map((m) => m.content || null));
  return temps.filter((m) => !contents.has(m.content || null));
}

/** Apply `fn` to the held live messages of every detached channel holding `messageId`. */
function mapHeldMessage(
  detached: Map<string, MessageWithUser[]>,
  messageId: string,
  fn: (message: MessageWithUser) => MessageWithUser | null,
): Map<string, MessageWithUser[]> {
  let next = detached;
  for (const [channelId, held] of detached) {
    if (!held.some((m) => m.id === messageId)) continue;
    const updated: MessageWithUser[] = [];
    for (const message of held) {
      if (message.id !== messageId) {
        updated.push(message);
        continue;
      }
      const mapped = fn(message);
      if (mapped) updated.push(mapped);
    }
    if (next === detached) next = new Map(detached);
    next.set(channelId, updated);
  }
  return next;
}

/** Read positions are snowflakes of the channel's origin; compare them as numbers. */
function isNewerId(candidate: string, than: string | undefined): boolean {
  if (than === undefined) return true;
  try {
    return BigInt(candidate) > BigInt(than);
  } catch {
    return false;
  }
}

function withLoadState(states: Map<string, ChannelLoadState>, channelId: string, state: ChannelLoadState | null): Map<string, ChannelLoadState> {
  const next = new Map(states);
  if (state) next.set(channelId, state);
  else next.delete(channelId);
  return next;
}
const MAX_CACHED_CHANNELS = 20;
const EVICT_TO_CHANNELS = 15;

// In-flight Promise dedup. The store has multiple call sites that may invoke
// `loadMessages` / `loadMoreMessages` for the same channel in parallel before
// the first call's awaited result has populated `hasMore`/`messages` (which is
// the only state-based dedup the original guards relied on):
//   - `AppLayout` and `MessageList` BOTH fire `loadMessages` on channel mount
//     because `MessageList` is also rendered by surfaces that don't have the
//     `AppLayout` chrome (`VoiceChatPanel`).
//   - `MessageList.handleScroll`'s load-more block can fire multiple times in
//     a single fast-scroll burst before React commits the `isLoadingMore=true`
//     state update, sharing one closure with `!isLoadingMore` still true.
// Without dedup, each parallel call opens its own federated fetch — on a NAT
// hairpin'd LAN this means N hung TCP connections per channel mount, and the
// pagination skeleton (driven by component-level `isLoadingMore`) sticks while
// any of them are still waiting on the 30 s api-client timeout.
const inFlightLoads = new Map<string, Promise<boolean>>();
const inFlightLoadMores = new Map<string, Promise<boolean>>();
const inFlightLoadNewers = new Map<string, Promise<LoadNewerResult>>();
const inFlightPresentReturns = new Map<string, Promise<boolean>>();

/** Run `load` once per channel at a time: a caller while it runs gets the same promise. */
async function dedupe<T>(inFlight: Map<string, Promise<T>>, channelId: string, load: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(channelId);
  if (existing) return existing;
  const promise = load();
  inFlight.set(channelId, promise);
  try {
    return await promise;
  } finally {
    // Only clear the entry if it still points at this promise.
    if (inFlight.get(channelId) === promise) inFlight.delete(channelId);
  }
}

interface TypingUser {
  userId: string;
  username: string;
  timestamp: number;
}

export interface RealtimeMessageEvent {
  channelId: string;
  message: MessageWithUser;
}

/** How many realtime message events the store keeps (oldest dropped first). */
export const REALTIME_MESSAGE_EVENT_CAP = 50;

/**
 * The events `next` gained over `prev`. The buffer is capped, so once it is full
 * its length stops growing; comparing lengths or slicing by the old length would
 * find nothing new. Events are compared by identity, which `addRealtimeMessage`
 * guarantees by always appending a fresh object.
 */
export function addedRealtimeMessageEvents(
  prev: readonly RealtimeMessageEvent[],
  next: readonly RealtimeMessageEvent[],
): RealtimeMessageEvent[] {
  if (prev === next) return [];
  const seen = new Set(prev);
  return next.filter((event) => !seen.has(event));
}

interface ChatState {
  messages: Map<string, MessageWithUser[]>;
  currentChannelId: string | null;
  typingUsers: Map<string, TypingUser[]>;
  hasMore: Map<string, boolean>;
  loadStates: Map<string, ChannelLoadState>;
  replyTo: MessageWithUser | null;
  editingMessageId: string | null;
  readStates: Map<string, string>;
  unreadChannels: Set<string>;
  realtimeMessageEvents: RealtimeMessageEvent[];
  channelAccessTimes: Map<string, number>;
  /**
   * Where each channel's view was held when it was last closed this session
   * (docs/systems/message-list.md, "Anchoring model"). In memory only.
   */
  scrollPositions: Map<string, ScrollAnchor>;
  /**
   * Channels whose cached messages are a window that stops short of the
   * newest message (loaded by `loadMessagesAround`), each with the live
   * messages that arrived since. Live messages are not appended to such a
   * window, which would put them after a gap; they are held here and join the
   * cache when a page reaches the present (`loadNewerMessages`,
   * `loadMessages`, `returnToPresent`), which removes the entry.
   * docs/systems/message-list.md, "Detached windows".
   */
  detachedChannels: Map<string, MessageWithUser[]>;
  /**
   * Per channel, how many times the store returned a detached window to the
   * present on its own (`returnToPresent`). The open list moves to the
   * newest message when it changes.
   */
  presentReturns: Map<string, number>;
  /**
   * The `reaction_add`s this client handed to an open socket and has not
   * seen answered, keyed by `reactionKey`, with the time each was sent. The
   * server answers a stored reaction with `reaction_added` and a refused one
   * with nothing, so an entry counts only for `REACTION_ADD_IN_FLIGHT_MS`.
   */
  reactionAddsInFlight: Map<string, number>;
  setCurrentChannel: (channelId: string | null) => void;
  saveScrollPosition: (channelId: string, anchor: ScrollAnchor) => void;
  setReplyTo: (message: MessageWithUser | null) => void;
  setEditingMessage: (messageId: string | null) => void;
  /**
   * Load the channel's newest page. Resolves true when the cache holds the
   * channel's messages (already loaded, or freshly fetched), false when they
   * could not be loaded (unknown origin, or the request failed).
   */
  loadMessages: (channelId: string, force?: boolean) => Promise<boolean>;
  clearAllMessages: () => void;
  loadMoreMessages: (channelId: string) => Promise<boolean>;
  /**
   * Page a detached window forward: load the messages after its greatest id
   * on the channel's origin and append them. A page shorter than the limit
   * reached the newest message and attaches the window.
   */
  loadNewerMessages: (channelId: string) => Promise<LoadNewerResult>;
  /**
   * Replace a detached window with the channel's newest page and bump
   * `presentReturns`, so the open list goes to the newest message. Resolves
   * true when the channel is attached (it already was, or the load worked).
   */
  returnToPresent: (channelId: string) => Promise<boolean>;
  sendMessage: (channelId: string, content: string, attachmentIds?: string[]) => Promise<void>;
  editMessage: (messageId: string, content: string, channelId: string) => Promise<void>;
  deleteMessage: (messageId: string, channelId: string) => Promise<void>;
  addMessage: (channelId: string, message: MessageWithUser) => void;
  addRealtimeMessage: (channelId: string, message: MessageWithUser) => void;
  updateMessage: (message: MessageWithUser) => void;
  removeMessage: (messageId: string, channelId: string) => void;
  /**
   * Whether the store holds the signed-in user's reaction with `emoji` on
   * the message: what the reaction pills show. An add still in flight does
   * not count, since nothing on screen shows it. Reads the store at call
   * time.
   */
  hasOwnReaction: (messageId: string, emoji: string) => boolean;
  /**
   * Send a `reaction_add`, unless the user already holds the reaction
   * (`hasOwnReaction`) or has an add for it in flight.
   */
  addReaction: (messageId: string, emoji: string) => void;
  removeReaction: (messageId: string, emoji: string) => void;
  onReactionAdded: (messageId: string, reaction: Reaction) => void;
  onReactionRemoved: (messageId: string, userId: string, emoji: string) => void;
  loadMessagesAround: (channelId: string, messageId: string) => Promise<LoadAroundResult>;
  setTyping: (channelId: string, userId: string, username: string) => void;
  clearTyping: (channelId: string, userId: string) => void;
  getMessages: (channelId: string) => MessageWithUser[];
  getTypingUsers: (channelId: string) => TypingUser[];
  setReadStates: (readStates: ReadState[], channelLastMessageIds: ReadonlyMap<string, string>, originChannelIds?: ReadonlySet<string>) => void;
  markChannelUnread: (channelId: string) => void;
  markUnread: (channelId: string, messageId: string) => void;
  ackChannel: (channelId: string) => void;
  onChannelAck: (channelId: string, messageId: string) => void;
  onMarkUnread: (channelId: string, messageId: string) => void;
  removeChannelStates: (channelIds: Set<string>) => void;
  rekeyChannelState: (oldId: string, newId: string) => void;
  /**
   * Apply a `user_updated` row issued by `origin` to the authors it is about
   * (`withUserUpdate`); each channel's rows are its origin's.
   */
  updateUserInMessages: (user: User, origin: string) => void;
  /**
   * Drop the typing entries of the deleted user's `user_updated` row (issued
   * by `origin`): a typing entry keeps only a row id, so only the issuing
   * instance's channels (`updateIsAboutRowId`). Each instance that holds a
   * row of the person sends its own event for it.
   */
  clearTypingForDeletedUser: (user: IdentityFields, origin: string) => void;
}

/** The client for the instance that owns `channelId`, and that instance's origin. */
function channelClient(channelId: string) {
  const origin = getChannelOrigin(channelId);
  return { origin, client: getApiForOrigin(origin) };
}

/** Rewrite a remote origin's asset paths (avatars, attachments) to absolute URLs. */
function normalizePage<T extends MessageWithUser>(messages: T[], origin: string): T[] {
  if (origin) {
    for (const msg of messages) normalizeMessageAssets(msg, origin);
  }
  return messages;
}

/** The channel's newest page, from the channel's origin. */
async function fetchNewestPage(channelId: string): Promise<MessageWithUser[]> {
  const { origin, client } = channelClient(channelId);
  const messages = isDmChannel(channelId)
    ? await client.dm.messages(channelId, undefined, HISTORY_PAGE_LIMIT)
    : await client.channels.messages(channelId, undefined, HISTORY_PAGE_LIMIT);
  return normalizePage(messages as MessageWithUser[], origin);
}

/**
 * The state after the channel's newest page replaced its cache: attached to
 * the present, with the live messages held while it was detached and the
 * optimistic sends the page does not answer yet. `present` marks a return to
 * the present the open list has to follow (`presentReturns`).
 */
function newestPageState(state: ChatState, channelId: string, page: MessageWithUser[], present: boolean): Partial<ChatState> {
  const held = state.detachedChannels.get(channelId);
  const messages = [...withHeldMessages(page, held), ...unconfirmedSends(state.messages.get(channelId), page)];
  const newMessages = new Map(state.messages);
  newMessages.set(channelId, messages);
  const newHasMore = new Map(state.hasMore);
  newHasMore.set(channelId, page.length >= HISTORY_PAGE_LIMIT);
  const newAccessTimes = new Map(state.channelAccessTimes);
  newAccessTimes.set(channelId, Date.now());
  let detachedChannels = state.detachedChannels;
  if (held !== undefined) {
    detachedChannels = new Map(detachedChannels);
    detachedChannels.delete(channelId);
  }
  const next: Partial<ChatState> = { messages: newMessages, hasMore: newHasMore, channelAccessTimes: newAccessTimes, detachedChannels };
  if (present) {
    const presentReturns = new Map(state.presentReturns);
    presentReturns.set(channelId, (presentReturns.get(channelId) ?? 0) + 1);
    next.presentReturns = presentReturns;
  }
  return next;
}

/** A message the store holds, loaded or held by a detached window, with its channel. */
function findHeldMessage(
  state: Pick<ChatState, 'messages' | 'detachedChannels'>,
  messageId: string,
): { channelId: string; message: MessageWithUser } | null {
  for (const source of [state.messages, state.detachedChannels]) {
    for (const [channelId, msgs] of source) {
      const message = msgs.find(m => m.id === messageId);
      if (message) return { channelId, message };
    }
  }
  return null;
}

/**
 * How long an unanswered `reaction_add` counts as in flight. The server sends
 * nothing back for an add it refuses, so an entry is not held for ever.
 */
export const REACTION_ADD_IN_FLIGHT_MS = 10_000;

/** One user's reaction on one message: the key the server keeps unique. */
function reactionKey(messageId: string, emoji: string): string {
  return JSON.stringify([messageId, emoji]);
}

/** Whether `reaction`, on a message of `channelId`, is the signed-in user's. */
function isOwnReactionIn(channelId: string, reaction: Pick<Reaction, 'userId' | 'user'>): boolean {
  return isMe(reaction.user ?? { id: reaction.userId }, getChannelOrigin(channelId));
}

/** `inFlight` without `key`, or `inFlight` itself when it has no such entry. */
function withoutInFlight(inFlight: Map<string, number>, key: string): Map<string, number> {
  if (!inFlight.has(key)) return inFlight;
  const next = new Map(inFlight);
  next.delete(key);
  return next;
}

/**
 * `reactions` with `reaction` appended, or unchanged when they already hold
 * it: the same row, or the same user's reaction with the same emoji (the
 * server stores one per user, emoji and message).
 */
function withReaction(reactions: readonly Reaction[] | undefined, reaction: Reaction): Reaction[] {
  const current = reactions ?? [];
  const held = current.some(r => r.id === reaction.id || (r.userId === reaction.userId && r.emoji === reaction.emoji));
  return held ? [...current] : [...current, reaction];
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: new Map(),
  currentChannelId: null,
  typingUsers: new Map(),
  hasMore: new Map(),
  loadStates: new Map(),
  replyTo: null,
  editingMessageId: null,
  readStates: new Map(),
  unreadChannels: new Set(),
  realtimeMessageEvents: [],
  channelAccessTimes: new Map(),
  scrollPositions: new Map(),
  detachedChannels: new Map(),
  presentReturns: new Map(),
  reactionAddsInFlight: new Map(),

  saveScrollPosition: (channelId, anchor) => {
    set((state) => {
      const newPositions = new Map(state.scrollPositions);
      newPositions.set(channelId, anchor);
      return { scrollPositions: newPositions };
    });
  },

  setCurrentChannel: (channelId) => {
    set((state) => {
      const newAccessTimes = new Map(state.channelAccessTimes);
      if (channelId) {
        newAccessTimes.set(channelId, Date.now());
      }

      // Evict stale channels if we have too many cached
      let newMessages = state.messages;
      let newHasMore = state.hasMore;
      let newScrollPositions = state.scrollPositions;
      let newDetached = state.detachedChannels;
      let newLoadStates = state.loadStates;
      if (state.messages.size > MAX_CACHED_CHANNELS) {
        const entries = [...newAccessTimes.entries()]
          .filter(([id]) => id !== channelId)
          .sort((a, b) => a[1] - b[1]);
        const toEvict = state.messages.size - EVICT_TO_CHANNELS;
        const evictIds = new Set(entries.slice(0, toEvict).map(([id]) => id));
        if (evictIds.size > 0) {
          newMessages = new Map(state.messages);
          newHasMore = new Map(state.hasMore);
          newScrollPositions = new Map(state.scrollPositions);
          newDetached = new Map(state.detachedChannels);
          newLoadStates = new Map(state.loadStates);
          for (const id of evictIds) {
            newMessages.delete(id);
            newHasMore.delete(id);
            newAccessTimes.delete(id);
            newScrollPositions.delete(id);
            newDetached.delete(id);
            newLoadStates.delete(id);
          }
        }
      }

      return {
        currentChannelId: channelId,
        editingMessageId: state.currentChannelId === channelId ? state.editingMessageId : null,
        channelAccessTimes: newAccessTimes,
        messages: newMessages,
        hasMore: newHasMore,
        scrollPositions: newScrollPositions,
        detachedChannels: newDetached,
        loadStates: newLoadStates,
      };
    });
  },
  setReplyTo: (message) => set({ replyTo: message }),
  setEditingMessage: (messageId) => set({ editingMessageId: messageId }),

  clearAllMessages: () => set({
    messages: new Map(),
    hasMore: new Map(),
    typingUsers: new Map(),
    readStates: new Map(),
    unreadChannels: new Set(),
    realtimeMessageEvents: [],
    channelAccessTimes: new Map(),
    scrollPositions: new Map(),
    detachedChannels: new Map(),
    presentReturns: new Map(),
    reactionAddsInFlight: new Map(),
    loadStates: new Map(),
    currentChannelId: null,
    replyTo: null,
    editingMessageId: null,
  }),

  loadMessages: async (channelId: string, force?: boolean) => {
    if (!force && get().hasMore.has(channelId)) return true;
    // An unknown channel (no ready has listed it yet) waits: which instance
    // and endpoint to ask depend on what the channel is.
    if (!isDmChannel(channelId) && !useSpaceStore.getState().channelOriginMap.has(channelId)) {
      if (get().loadStates.get(channelId)?.status !== 'waiting') {
        set((state) => ({ loadStates: withLoadState(state.loadStates, channelId, { status: 'waiting' }) }));
      }
      return false;
    }

    // Parallel-call dedup: if a load for this channel is already in flight,
    // return that Promise instead of starting a second fetch. Applies to
    // force=true callers as well: two callers asking for the newest page at
    // once get the same data, and the force caller still gets a fresh result
    // via the in-flight Promise. A force-reload scheduled after the entry was
    // replaced keeps its own entry (see `dedupe`).
    return dedupe(inFlightLoads, channelId, async () => {
      set((state) => ({ loadStates: withLoadState(state.loadStates, channelId, { status: 'loading' }) }));
      try {
        const page = await fetchNewestPage(channelId);
        set((state) => ({
          ...newestPageState(state, channelId, page, false),
          loadStates: withLoadState(state.loadStates, channelId, null),
        }));
        return true;
      } catch (err) {
        set((state) => ({ loadStates: withLoadState(state.loadStates, channelId, { status: 'failed', error: err }) }));
        return false;
      }
    });
  },

  returnToPresent: async (channelId: string) => {
    if (!get().detachedChannels.has(channelId)) return true;
    return dedupe(inFlightPresentReturns, channelId, async () => {
      try {
        const page = await fetchNewestPage(channelId);
        // Another path attached the channel meanwhile (Jump to Present, a
        // reload): the cache is already the present.
        if (!get().detachedChannels.has(channelId)) return true;
        set((state) => newestPageState(state, channelId, page, true));
        return true;
      } catch (err) {
        console.error('Failed to return to the newest messages:', err);
        return false;
      }
    });
  },

  loadMoreMessages: async (channelId: string) => {
    const existing = get().messages.get(channelId);
    if (!existing || existing.length === 0) return false;
    if (!get().hasMore.get(channelId)) return false;

    const oldestMessage = existing[0];
    if (!oldestMessage) return false;

    // Parallel-call dedup. `MessageList.handleScroll`'s load-more block can
    // fire several times in one fast-scroll burst before React commits the
    // `isLoadingMore=true` setState — every call sees the same closure with
    // `!isLoadingMore` still true. Without dedup, each spawns its own
    // federated fetch, and on a NAT hairpin'd LAN that means N hung TCP
    // connections per scroll burst, each independently waiting on the 30 s
    // api-client timeout. Dedup collapses them to one, and every caller's
    // `await` resolves together.
    return dedupe(inFlightLoadMores, channelId, async () => {
      try {
        const { origin, client } = channelClient(channelId);
        const olderMessages = normalizePage((isDmChannel(channelId)
          ? await client.dm.messages(channelId, oldestMessage.id, HISTORY_PAGE_LIMIT)
          : await client.channels.messages(channelId, oldestMessage.id, HISTORY_PAGE_LIMIT)) as MessageWithUser[], origin);

        set((state) => {
          const newMessages = new Map(state.messages);
          const current = newMessages.get(channelId) ?? [];
          newMessages.set(channelId, [...olderMessages, ...current]);
          const newHasMore = new Map(state.hasMore);
          newHasMore.set(channelId, olderMessages.length >= HISTORY_PAGE_LIMIT);
          return { messages: newMessages, hasMore: newHasMore };
        });
        return olderMessages.length > 0;
      } catch {
        return false;
      }
    });
  },

  loadNewerMessages: async (channelId: string) => {
    if (!get().detachedChannels.has(channelId)) return 'skipped';
    const cursor = greatestServerId(get().messages.get(channelId) ?? []);
    if (cursor === null) return 'skipped';

    return dedupe(inFlightLoadNewers, channelId, async (): Promise<LoadNewerResult> => {
      let messages: MessageWithUser[];
      let forward: boolean;
      try {
        const { origin, client } = channelClient(channelId);
        const page = isDmChannel(channelId)
          ? await client.dm.messagesAfter(channelId, cursor, HISTORY_PAGE_LIMIT)
          : await client.channels.messagesAfter(channelId, cursor, HISTORY_PAGE_LIMIT);
        messages = normalizePage(page.messages as MessageWithUser[], origin);
        forward = page.forward;
      } catch (err) {
        console.error('Failed to load newer messages:', err);
        return 'failed';
      }

      // The page continues the window it was asked for. If that window is
      // gone (Jump to Present, a new jump, a reload, eviction), it is stale.
      const state = get();
      if (!state.detachedChannels.has(channelId) || greatestServerId(state.messages.get(channelId) ?? []) !== cursor) {
        return 'skipped';
      }

      // An origin that predates forward paging ignored the cursor and sent
      // its newest page. Splicing it after the window would hide a gap, so it
      // replaces the window as a return to the present.
      if (!forward) {
        set((current) => newestPageState(current, channelId, messages, true));
        return 'present';
      }

      const reachedPresent = messages.length < HISTORY_PAGE_LIMIT;
      set((current) => {
        const cached = current.messages.get(channelId) ?? [];
        const known = new Set(cached.map((m) => m.id));
        let next = [...cached, ...messages.filter((m) => !known.has(m.id))];
        let detachedChannels = current.detachedChannels;
        if (reachedPresent) {
          next = withHeldMessages(next, current.detachedChannels.get(channelId));
          detachedChannels = new Map(detachedChannels);
          detachedChannels.delete(channelId);
        }
        const newMessages = new Map(current.messages);
        newMessages.set(channelId, next);
        const newAccessTimes = new Map(current.channelAccessTimes);
        newAccessTimes.set(channelId, Date.now());
        return { messages: newMessages, detachedChannels, channelAccessTimes: newAccessTimes };
      });
      return reachedPresent ? 'attached' : 'paged';
    });
  },

  loadMessagesAround: async (channelId: string, messageId: string) => {
    const isDm = isDmChannel(channelId);
    if (!isDm && !useSpaceStore.getState().channelOriginMap.has(channelId)) return 'failed';
    let messages: MessageWithUser[];
    try {
      const { origin, client } = channelClient(channelId);
      messages = normalizePage((isDm
        ? await client.dm.messagesAround(channelId, messageId, MESSAGES_AROUND_LIMIT)
        : await client.channels.messagesAround(channelId, messageId, MESSAGES_AROUND_LIMIT)) as MessageWithUser[], origin);
    } catch (err) {
      // Any 404 here is the target: the channel itself is open in front of
      // the user. Older peers send the 404 without a code, so the status is
      // what decides.
      if (err instanceof HttpError && err.status === 404) return 'not_found';
      console.error('Failed to load messages around:', err);
      return 'failed';
    }

    const targetIndex = messages.findIndex((m) => m.id === messageId);
    const newerCount = targetIndex === -1 ? 0 : messages.length - 1 - targetIndex;
    const reachesPresent = newerCount < Math.floor(MESSAGES_AROUND_LIMIT / 2);

    set((state) => {
      // Live messages held while an earlier window was detached stay held
      // for this one, or join it when it reaches the present.
      const held = state.detachedChannels.get(channelId);
      const newMessages = new Map(state.messages);
      newMessages.set(channelId, reachesPresent ? withHeldMessages(messages, held) : messages);
      const newHasMore = new Map(state.hasMore);
      newHasMore.set(channelId, true);
      const newAccessTimes = new Map(state.channelAccessTimes);
      newAccessTimes.set(channelId, Date.now());
      const detachedChannels = new Map(state.detachedChannels);
      if (reachesPresent) detachedChannels.delete(channelId);
      else detachedChannels.set(channelId, held ?? []);
      return { messages: newMessages, hasMore: newHasMore, channelAccessTimes: newAccessTimes, detachedChannels };
    });
    return 'loaded';
  },

  sendMessage: async (channelId: string, content: string, attachmentIds?: string[]) => {
    const replyToId = get().replyTo?.id;
    const isDm = isDmChannel(channelId);
    const origin = getChannelOrigin(channelId);
    // The user's row as the channel's instance issues it: the optimistic
    // message is checked against that origin (own message, edit, profile).
    const myRow = myRowForOrigin(origin);
    const client = getApiForOrigin(origin);

    // Sending from a window of older history goes back to the present, where
    // the message will appear.
    void get().returnToPresent(channelId);

    // Generate optimistic message
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (myRow) {
      const optimisticMessage: MessageWithUser = {
        id: tempId,
        channelId: isDm ? '' : channelId,
        userId: myRow.id,
        content: content || null,
        replyToId: replyToId ?? null,
        editedAt: null,
        createdAt: Date.now(),
        user: myRow,
        attachments: [],
        embeds: [],
        reactions: [],
        replyTo: get().replyTo ?? undefined,
      };
      if (isDm) {
        (optimisticMessage as any).dmChannelId = channelId;
      }
      // Add optimistic message immediately
      get().addMessage(channelId, optimisticMessage);

      // For DMs, update lastMessage on the DM channel so sidebar re-sorts
      if (isDm) {
        useSpaceStore.getState().patchDmCopy(channelId, dm => ({
          ...dm,
          lastMessage: { id: tempId, dmChannelId: channelId, userId: myRow.id, content, createdAt: Date.now() },
        }));
      }
    }

    set({ replyTo: null });

    try {
      if (isDm) {
        await client.dm.sendMessage(channelId, { content, attachments: attachmentIds, replyToId });
      } else {
        await client.channels.sendMessage(channelId, { content, attachments: attachmentIds, replyToId });
      }
      // Real message will arrive via WebSocket and replace the temp one
    } catch {
      // Rollback: remove the optimistic message on failure
      get().removeMessage(tempId, channelId);
    }
  },

  editMessage: async (messageId: string, content: string, channelId: string) => {
    const isDm = isDmChannel(channelId);
    const origin = getChannelOrigin(channelId);
    const client = getApiForOrigin(origin);

    // Optimistic: update content locally first
    const messages = get().messages.get(channelId);
    const originalMessage = messages?.find(m => m.id === messageId);
    if (originalMessage) {
      get().updateMessage({ ...originalMessage, content, editedAt: Date.now() });
    }
    try {
      if (isDm) {
        await client.dm.updateMessage(messageId, { content });
      } else {
        await client.messages.update(messageId, { content });
      }
      // Real update will arrive via WebSocket
    } catch {
      // Rollback: restore the original message on failure
      if (originalMessage) {
        get().updateMessage(originalMessage);
      }
    }
  },

  deleteMessage: async (messageId: string, channelId: string) => {
    const isDm = isDmChannel(channelId);
    const origin = getChannelOrigin(channelId);
    const client = getApiForOrigin(origin);

    // Optimistic: remove locally first
    const messages = get().messages.get(channelId);
    const savedMessage = messages?.find(m => m.id === messageId);
    get().removeMessage(messageId, channelId);
    try {
      if (isDm) {
        await client.dm.deleteMessage(messageId);
      } else {
        await client.messages.delete(messageId);
      }
      // Real deletion will arrive via WebSocket (already removed locally)
    } catch {
      // Rollback: re-add the message on failure
      if (savedMessage) {
        get().addMessage(channelId, savedMessage);
      }
    }
  },

  addMessage: (channelId: string, message: MessageWithUser) => {
    const normalizedMessage = { ...message, embeds: message.embeds ?? [] };
    set((state) => {
      const newMessages = new Map(state.messages);
      const current = newMessages.get(channelId) ?? [];
      // Avoid duplicates
      if (current.find(m => m.id === normalizedMessage.id)) return state;
      // Dedup against pendingMessageStore by (content, sortedAttachmentIds).
      // No userId check — federation relays arrive with replicated user IDs.
      const sortedAttIds = (normalizedMessage.attachments ?? []).map((a) => a.id).sort();
      usePendingMessageStore.getState().matchAndRemove(channelId, normalizedMessage.content ?? '', sortedAttIds);
      // Remove any optimistic temp message with same content.
      // Don't require userId match — for federated messages the home user ID
      // differs from the replicated user ID, but content match is sufficient
      // since temp messages are unique within the short optimistic window.
      // Normalize both sides: empty string and null are equivalent (server stores null for empty content).
      const filtered = current.filter(m => {
        if (!m.id.startsWith('temp_')) return true;
        return (m.content || null) !== (normalizedMessage.content || null);
      });
      let updated = [...filtered, normalizedMessage];
      // Cap per-channel messages to prevent memory growth
      if (updated.length > MAX_MESSAGES_PER_CHANNEL) {
        updated = updated.slice(updated.length - MAX_MESSAGES_PER_CHANNEL);
      }
      newMessages.set(channelId, updated);
      return { messages: newMessages };
    });
  },

  addRealtimeMessage: (channelId: string, message: MessageWithUser) => {
    const normalizedMessage = { ...message, embeds: message.embeds ?? [] };
    set((state) => {
      const current = state.messages.get(channelId) ?? [];
      const held = state.detachedChannels.get(channelId);
      const known = held ? [...current, ...held] : current;
      // Avoid duplicates
      if (known.find(m => m.id === normalizedMessage.id)) return state;
      // Federation relay dedup: skip if this is a relay copy of a message we
      // already have (sourceMessageId matches an existing ID), or if we already
      // have the relay copy and the original is now arriving (existing
      // sourceMessageId matches incoming ID).
      if ('sourceMessageId' in normalizedMessage && normalizedMessage.sourceMessageId
        && known.find(m => m.id === normalizedMessage.sourceMessageId)) return state;
      if (known.find(m => 'sourceMessageId' in m && m.sourceMessageId === normalizedMessage.id)) return state;
      // Dedup against pendingMessageStore by (content, sortedAttachmentIds).
      // No userId check — federation relays arrive with replicated user IDs.
      const sortedAttIds = (normalizedMessage.attachments ?? []).map((a) => a.id).sort();
      usePendingMessageStore.getState().matchAndRemove(channelId, normalizedMessage.content ?? '', sortedAttIds);
      // Remove any optimistic temp message with same content (no userId check —
      // federated messages arrive with a different replicated user ID).
      // Normalize both sides: empty string and null are equivalent (server stores null for empty content).
      const filtered = current.filter(m => {
        if (!m.id.startsWith('temp_')) return true;
        return (m.content || null) !== (normalizedMessage.content || null);
      });
      const newMessages = new Map(state.messages);
      let detachedChannels = state.detachedChannels;
      if (held) {
        // The cache is a window short of the newest message: the message
        // belongs after a gap, so it is held until a page reaches the present.
        if (filtered.length !== current.length) newMessages.set(channelId, filtered);
        let nextHeld = [...held, normalizedMessage];
        if (nextHeld.length > MAX_MESSAGES_PER_CHANNEL) {
          nextHeld = nextHeld.slice(nextHeld.length - MAX_MESSAGES_PER_CHANNEL);
        }
        detachedChannels = new Map(detachedChannels);
        detachedChannels.set(channelId, nextHeld);
      } else {
        let updated = [...filtered, normalizedMessage];
        // Cap per-channel messages to prevent memory growth
        if (updated.length > MAX_MESSAGES_PER_CHANNEL) {
          updated = updated.slice(updated.length - MAX_MESSAGES_PER_CHANNEL);
        }
        newMessages.set(channelId, updated);
      }
      // Append to realtimeMessageEvents (capped; see addedRealtimeMessageEvents)
      const newEvents = [...state.realtimeMessageEvents, { channelId, message: normalizedMessage }];
      if (newEvents.length > REALTIME_MESSAGE_EVENT_CAP) {
        newEvents.splice(0, newEvents.length - REALTIME_MESSAGE_EVENT_CAP);
      }
      return { messages: newMessages, detachedChannels, realtimeMessageEvents: newEvents };
    });
  },

  updateMessage: (message: MessageWithUser) => {
    // DM messages have dmChannelId instead of channelId — check both
    const channelKey = message.channelId || (message as any).dmChannelId;
    if (!channelKey) return;
    const normalizedMessage = { ...message, embeds: message.embeds ?? [] };
    set((state) => {
      const detachedChannels = mapHeldMessage(state.detachedChannels, normalizedMessage.id, () => normalizedMessage);
      const current = state.messages.get(channelKey);
      if (!current) return detachedChannels === state.detachedChannels ? state : { detachedChannels };
      const newMessages = new Map(state.messages);
      newMessages.set(
        channelKey,
        current.map(m => m.id === normalizedMessage.id ? normalizedMessage : m),
      );
      return { messages: newMessages, detachedChannels };
    });
  },

  removeMessage: (messageId: string, channelId: string) => {
    set((state) => {
      const detachedChannels = mapHeldMessage(state.detachedChannels, messageId, () => null);
      const current = state.messages.get(channelId);
      if (!current) return detachedChannels === state.detachedChannels ? state : { detachedChannels };
      const newMessages = new Map(state.messages);
      newMessages.set(channelId, current.filter(m => m.id !== messageId));
      return {
        messages: newMessages,
        detachedChannels,
        editingMessageId: state.editingMessageId === messageId ? null : state.editingMessageId,
      };
    });
  },

  hasOwnReaction: (messageId: string, emoji: string) => {
    const held = findHeldMessage(get(), messageId);
    if (!held) return false;
    return (held.message.reactions ?? []).some(r => r.emoji === emoji && isOwnReactionIn(held.channelId, r));
  },

  addReaction: (messageId: string, emoji: string) => {
    // A second add of a reaction the user holds, or has an add in flight
    // for, is never sent: the server keeps one per user and emoji.
    const sentAt = get().reactionAddsInFlight.get(reactionKey(messageId, emoji));
    if (sentAt !== undefined && Date.now() - sentAt < REACTION_ADD_IN_FLIGHT_MS) return;
    if (get().hasOwnReaction(messageId, emoji)) return;
    // Resolve the channel from our message cache so the UI doesn't need to pass it
    const channelId = findHeldMessage(get(), messageId)?.channelId;
    const origin = channelId ? getChannelOrigin(channelId) : '';
    // An add the socket did not take (the origin is reconnecting, say) is
    // not in flight: the next tap sends it again.
    if (!wsSend({ type: 'reaction_add', messageId, emoji }, origin)) return;
    set((state) => {
      const reactionAddsInFlight = new Map(state.reactionAddsInFlight);
      reactionAddsInFlight.set(reactionKey(messageId, emoji), Date.now());
      return { reactionAddsInFlight };
    });
  },

  removeReaction: (messageId: string, emoji: string) => {
    const channelId = findHeldMessage(get(), messageId)?.channelId;
    const origin = channelId ? getChannelOrigin(channelId) : '';
    // The server applies the add before this removal, so the add's answer no
    // longer matters here.
    set((state) => {
      const reactionAddsInFlight = withoutInFlight(state.reactionAddsInFlight, reactionKey(messageId, emoji));
      return reactionAddsInFlight === state.reactionAddsInFlight ? state : { reactionAddsInFlight };
    });
    wsSend({ type: 'reaction_remove', messageId, emoji }, origin);
  },

  onReactionAdded: (messageId: string, reaction: Reaction) => {
    set((state) => {
      const held = findHeldMessage(state, messageId);
      const reactionAddsInFlight = held && isOwnReactionIn(held.channelId, reaction)
        ? withoutInFlight(state.reactionAddsInFlight, reactionKey(messageId, reaction.emoji))
        : state.reactionAddsInFlight;
      const detachedChannels = mapHeldMessage(state.detachedChannels, messageId, (m) => ({
        ...m,
        reactions: withReaction(m.reactions, reaction),
      }));
      const newMessages = new Map(state.messages);
      for (const [channelId, msgs] of newMessages.entries()) {
        const msgIndex = msgs.findIndex(m => m.id === messageId);
        if (msgIndex !== -1) {
          const newMsgs = [...msgs];
          const oldMsg = newMsgs[msgIndex]!;
          newMsgs[msgIndex] = {
            ...oldMsg,
            reactions: withReaction(oldMsg.reactions, reaction),
          };
          newMessages.set(channelId, newMsgs);
          break;
        }
      }
      return { messages: newMessages, detachedChannels, reactionAddsInFlight };
    });
  },

  onReactionRemoved: (messageId: string, userId: string, emoji: string) => {
    set((state) => {
      const detachedChannels = mapHeldMessage(state.detachedChannels, messageId, (m) => ({
        ...m,
        reactions: (m.reactions || []).filter(r => !(r.userId === userId && r.emoji === emoji)),
      }));
      const newMessages = new Map(state.messages);
      for (const [channelId, msgs] of newMessages.entries()) {
        const msgIndex = msgs.findIndex(m => m.id === messageId);
        if (msgIndex !== -1) {
          const newMsgs = [...msgs];
          const oldMsg = newMsgs[msgIndex]!;
          newMsgs[msgIndex] = {
            ...oldMsg,
            reactions: (oldMsg.reactions || []).filter(r => !(r.userId === userId && r.emoji === emoji)),
          };
          newMessages.set(channelId, newMsgs);
          break;
        }
      }
      return { messages: newMessages, detachedChannels };
    });
  },

  setTyping: (channelId: string, userId: string, username: string) => {
    set((state) => {
      const newTyping = new Map(state.typingUsers);
      const current = newTyping.get(channelId) ?? [];
      const filtered = current.filter(t => t.userId !== userId);
      filtered.push({ userId, username, timestamp: Date.now() });
      newTyping.set(channelId, filtered);
      return { typingUsers: newTyping };
    });

    // Auto-clear after 5 seconds
    setTimeout(() => {
      get().clearTyping(channelId, userId);
    }, 5000);
  },

  clearTyping: (channelId: string, userId: string) => {
    set((state) => {
      const newTyping = new Map(state.typingUsers);
      const current = newTyping.get(channelId);
      if (!current) return state;
      newTyping.set(channelId, current.filter(t => t.userId !== userId));
      return { typingUsers: newTyping };
    });
  },

  getMessages: (channelId: string) => {
    return get().messages.get(channelId) ?? [];
  },

  getTypingUsers: (channelId: string) => {
    const users = get().typingUsers.get(channelId) ?? [];
    const now = Date.now();
    return users.filter(t => now - t.timestamp < 5000);
  },

  setReadStates: (readStates: ReadState[], channelLastMessageIds: ReadonlyMap<string, string>, originChannelIds?: ReadonlySet<string>) => {
    // 1. Merge server read states into existing local state (preserves optimistic acks)
    const rsMap = new Map(get().readStates);
    for (const rs of readStates) {
      const local = rsMap.get(rs.channelId);
      if (!local) {
        rsMap.set(rs.channelId, rs.lastReadMessageId);
      } else {
        try {
          if (BigInt(rs.lastReadMessageId) > BigInt(local)) {
            rsMap.set(rs.channelId, rs.lastReadMessageId);
          }
        } catch {
          rsMap.set(rs.channelId, rs.lastReadMessageId);
        }
      }
    }

    // 2. Rebuild unreadChannels ONLY for channels from this origin
    //    Keep existing unread entries from other origins untouched,
    //    but prune orphans that don't map to any known channel
    const currentChannelId = get().currentChannelId;
    const { channelToSpaceMap, dmChannels: knownDms } = useSpaceStore.getState();
    const knownDmIds = new Set(knownDms.map(dm => dm.id));
    const unread = new Set<string>();
    for (const id of get().unreadChannels) {
      if (!originChannelIds || !originChannelIds.has(id)) {
        // Only preserve if the channel still maps to a known space or DM
        if (channelToSpaceMap.has(id) || knownDmIds.has(id)) {
          unread.add(id);
        }
      }
    }

    const channelsToCheck = originChannelIds ?? new Set(channelLastMessageIds.keys());
    for (const channelId of channelsToCheck) {
      if (channelId === currentChannelId) continue; // skip current channel (acked momentarily)
      const lastMsgId = channelLastMessageIds.get(channelId);
      if (!lastMsgId) continue; // empty channel
      const lastRead = rsMap.get(channelId);
      if (!lastRead) {
        unread.add(channelId);
        continue;
      }
      try {
        if (BigInt(lastMsgId) > BigInt(lastRead)) {
          unread.add(channelId);
        }
      } catch {
        unread.add(channelId);
      }
    }

    set({ readStates: rsMap, unreadChannels: unread });

    // Re-sort DM list now that unread state is known (handles initial load
    // where populateFromReady runs before read states are processed)
    useSpaceStore.getState().resortDmChannels(currentChannelId);
  },

  markChannelUnread: (channelId: string) => {
    set((state) => {
      if (state.unreadChannels.has(channelId)) return state;
      const newUnread = new Set(state.unreadChannels);
      newUnread.add(channelId);
      return { unreadChannels: newUnread };
    });
  },

  markUnread: (channelId: string, messageId: string) => {
    // Optimistically update local state
    set((state) => {
      const newReadStates = new Map(state.readStates);
      const newUnread = new Set(state.unreadChannels);
      if (messageId === '0') {
        newReadStates.delete(channelId);
      } else {
        newReadStates.set(channelId, messageId);
      }
      newUnread.add(channelId);
      return { readStates: newReadStates, unreadChannels: newUnread };
    });

    // Send to the correct federated instance
    const origin = getChannelOrigin(channelId);
    wsSend({ type: 'mark_unread', channelId, messageId }, origin);
  },

  ackChannel: (channelId: string) => {
    const msgs = get().messages.get(channelId);
    if (!msgs || msgs.length === 0) return;
    // A detached window stops short of the newest message: reaching its end
    // has not read the channel.
    if (get().detachedChannels.has(channelId)) return;

    // The highest server-confirmed id, not the last in display order: the ack
    // must cover the highest id to stay consistent with the server's
    // read-state comparison (see greatestServerId).
    const messageId = greatestServerId(msgs);
    if (!messageId) return; // All messages are temp — nothing to ack yet
    // Read positions only move forward.
    if (!isNewerId(messageId, get().readStates.get(channelId))) return;
    const ackedId = messageId;

    // Update local state immediately
    set((state) => {
      const newReadStates = new Map(state.readStates);
      newReadStates.set(channelId, ackedId);
      const newUnread = new Set(state.unreadChannels);
      newUnread.delete(channelId);
      return { readStates: newReadStates, unreadChannels: newUnread };
    });

    // Re-sort DM list when a DM is marked as read (moves from unread to read group)
    if (isDmChannel(channelId)) {
      useSpaceStore.getState().resortDmChannels(channelId);
    }

    // Send to the correct instance
    const origin = getChannelOrigin(channelId);
    wsSend({ type: 'channel_ack', channelId, messageId: ackedId }, origin);
  },

  onChannelAck: (channelId: string, messageId: string) => {
    set((state) => {
      // The server echoes the id it was sent even when it kept a newer one;
      // an older echo changes nothing here either.
      const current = state.readStates.get(channelId);
      if (current !== undefined && current !== messageId && !isNewerId(messageId, current)) return state;
      const newReadStates = new Map(state.readStates);
      newReadStates.set(channelId, messageId);
      const newUnread = new Set(state.unreadChannels);
      newUnread.delete(channelId);
      return { readStates: newReadStates, unreadChannels: newUnread };
    });
  },

  onMarkUnread: (channelId: string, messageId: string) => {
    set((state) => {
      const newReadStates = new Map(state.readStates);
      const newUnread = new Set(state.unreadChannels);
      if (messageId === '0') {
        newReadStates.delete(channelId);
      } else {
        newReadStates.set(channelId, messageId);
      }
      newUnread.add(channelId);
      return { readStates: newReadStates, unreadChannels: newUnread };
    });
  },

  removeChannelStates: (channelIds: Set<string>) => {
    if (channelIds.size === 0) return;
    set((state) => {
      const newUnread = new Set(state.unreadChannels);
      const newReadStates = new Map(state.readStates);
      const newMessages = new Map(state.messages);
      const newHasMore = new Map(state.hasMore);
      const newDetached = new Map(state.detachedChannels);
      const newLoadStates = new Map(state.loadStates);
      for (const channelId of channelIds) {
        newUnread.delete(channelId);
        newReadStates.delete(channelId);
        newMessages.delete(channelId);
        newHasMore.delete(channelId);
        newDetached.delete(channelId);
        newLoadStates.delete(channelId);
      }
      return { unreadChannels: newUnread, readStates: newReadStates, messages: newMessages, hasMore: newHasMore, detachedChannels: newDetached, loadStates: newLoadStates };
    });
  },

  rekeyChannelState: (oldId: string, newId: string) => {
    set((state) => {
      const copyDelete = <V,>(src: Map<string, V>): Map<string, V> => {
        if (!src.has(oldId)) return src;
        const next = new Map(src);
        next.delete(oldId);
        return next;
      };

      const messages = copyDelete(state.messages);
      const typingUsers = copyDelete(state.typingUsers);
      const hasMore = copyDelete(state.hasMore);
      const readStates = copyDelete(state.readStates);
      const channelAccessTimes = copyDelete(state.channelAccessTimes);
      const scrollPositions = copyDelete(state.scrollPositions);
      const loadStates = copyDelete(state.loadStates);
      // The message cache is dropped for oldId and refetched under newId, so
      // the new key starts attached to the present.
      let detachedChannels = state.detachedChannels;
      if (detachedChannels.has(oldId)) {
        detachedChannels = new Map(detachedChannels);
        detachedChannels.delete(oldId);
      }

      let unreadChannels = state.unreadChannels;
      if (state.unreadChannels.has(oldId)) {
        unreadChannels = new Set(state.unreadChannels);
        unreadChannels.delete(oldId);
        unreadChannels.add(newId);
      }

      const currentChannelId = state.currentChannelId === oldId ? newId : state.currentChannelId;

      return {
        messages,
        typingUsers,
        hasMore,
        readStates,
        channelAccessTimes,
        scrollPositions,
        loadStates,
        detachedChannels,
        unreadChannels,
        currentChannelId,
      };
    });
  },

  updateUserInMessages: (user: User, origin: string) => {
    set((state) => {
      const newMessages = new Map(state.messages);
      let changed = false;
      for (const [channelId, msgs] of newMessages) {
        const channelOrigin = getChannelOrigin(channelId);
        let channelChanged = false;
        const updated = msgs.map(m => {
          if (!m.user) return m;
          const author = withUserUpdate(m.user, channelOrigin, user, origin);
          if (author === m.user) return m;
          channelChanged = true;
          return { ...m, user: author };
        });
        if (channelChanged) { newMessages.set(channelId, updated); changed = true; }
      }
      return changed ? { messages: newMessages } : {};
    });
  },

  clearTypingForDeletedUser: (user: IdentityFields, origin: string) => {
    set((state) => {
      const newTyping = new Map(state.typingUsers);
      let changed = false;
      for (const [channelId, users] of newTyping) {
        const channelOrigin = getChannelOrigin(channelId);
        const filtered = users.filter(t => !updateIsAboutRowId(t.userId, channelOrigin, user, origin));
        if (filtered.length !== users.length) {
          newTyping.set(channelId, filtered);
          changed = true;
        }
      }
      return changed ? { typingUsers: newTyping } : state;
    });
  },
}));
