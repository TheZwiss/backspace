import type { DmChannel, DmMessageWithUser, MessageWithUser } from '@backspace/shared';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import { useSpaceStore, getMyUserIdForOrigin, resolveDmChannelId } from '../stores/spaceStore';
import { sortDmChannels } from './dmSorting';
import { repinDmsToHomeCopies } from './dmOriginFailover';

/**
 * Routing of DM WebSocket events to the conversation they belong to.
 *
 * A DM channel id is local to the instance that sent it. One conversation can
 * reach this client under several ids: the copy the client pinned in
 * `dmChannels` (the primary), and the mirrored copies other connected
 * instances hold, which `dmAlternatives` records under the conversation's
 * `federatedId`. The only thing that says two ids are the same conversation is
 * that `federatedId`. Who wrote a message says nothing about which
 * conversation it is in: the signed-in user is a member of every one of their
 * DMs, so matching on the author put a message the user sent to one person
 * into whichever of their DMs sorted first (#296).
 *
 * An id this client has not seen from that origin is looked up by asking the
 * origin for its DM list, which carries the `federatedId`. If that does not
 * place it, the message gets an entry of its own. It is never assigned to a
 * conversation by guessing.
 *
 * Only the pinned copy's messages enter the conversation's message list, so
 * every message id in it is one the pinned origin knows (see
 * `deliverToConversation`). The pinned copy is the home instance's whenever
 * the client has seen it (`repinDmsToHomeCopies`), because home is the one
 * copy every relay of the conversation is guaranteed to reach.
 */

const HOME_ORIGIN = '';

/** The chat store keys DM messages alongside space messages under one shape. */
function asChatMessage(message: DmMessageWithUser): MessageWithUser {
  return message as unknown as MessageWithUser;
}

/** One DM-list refetch per origin at a time; concurrent unknown ids share it. */
const inFlightDmListLoads = new Map<string, Promise<boolean>>();

function learnDmChannelsFromOrigin(origin: string): Promise<boolean> {
  const existing = inFlightDmListLoads.get(origin);
  if (existing) return existing;
  const load = useSpaceStore.getState().reloadDmsForOrigin(origin)
    .then(() => {
      repinDmsToHomeCopies();
      return true;
    })
    .catch((err: unknown) => {
      console.warn(`[dm] could not load the DM list from ${origin || 'home'}:`, err);
      return false;
    })
    .finally(() => {
      if (inFlightDmListLoads.get(origin) === load) inFlightDmListLoads.delete(origin);
    });
  inFlightDmListLoads.set(origin, load);
  return load;
}

function isOwnMessage(origin: string, message: DmMessageWithUser): boolean {
  const myId = origin === HOME_ORIGIN ? useAuthStore.getState().user?.id : getMyUserIdForOrigin(origin);
  return message.userId === myId;
}

/** Set the sidebar preview of `channelId` and mark it unread when it is someone else's message in a DM not on screen. */
function recordLastMessage(origin: string, channelId: string, message: DmMessageWithUser): void {
  const { dmChannels, setDmChannels } = useSpaceStore.getState();
  const updatedDms = dmChannels.map(dm => (dm.id === channelId ? { ...dm, lastMessage: message } : dm));
  const { unreadChannels, currentChannelId, markChannelUnread } = useChatStore.getState();
  setDmChannels(sortDmChannels(updatedDms, unreadChannels, currentChannelId));
  if (channelId !== currentChannelId && !isOwnMessage(origin, message)) {
    markChannelUnread(channelId);
  }
}

/**
 * Deliver `message` into the known conversation `primaryId`, if this is the
 * pinned copy.
 *
 * A mirrored copy (the channel id is one of `dmAlternatives`, not the pinned
 * entry) is not added. Its message id is the mirroring instance's local id,
 * while every action on a message (reply, reaction, edit, delete) is sent to
 * the pinned origin, which knows only its own ids: a reply to a mirrored copy
 * was refused as an invalid reply target and a reaction was silently dropped
 * (#295). The pinned origin receives the same message over the S2S relay and
 * delivers its own copy, which sets the preview and unread state.
 */
function deliverToConversation(origin: string, primaryId: string, message: DmMessageWithUser): void {
  if (primaryId !== message.dmChannelId) return;
  useChatStore.getState().addRealtimeMessage(primaryId, asChatMessage(message));
  recordLastMessage(origin, primaryId, message);
}

/** A conversation no list placed: give it its own entry under the origin that sent it. */
function deliverAsNewConversation(origin: string, message: DmMessageWithUser): void {
  useChatStore.getState().addRealtimeMessage(message.dmChannelId, asChatMessage(message));
  useSpaceStore.getState().addDmChannel({
    id: message.dmChannelId,
    createdAt: message.createdAt,
    members: message.user ? [message.user] : [],
    lastMessage: message,
  }, origin);
  const { currentChannelId, markChannelUnread } = useChatStore.getState();
  if (message.dmChannelId !== currentChannelId && !isOwnMessage(origin, message)) {
    markChannelUnread(message.dmChannelId);
  }
}

/**
 * Apply a `dm_message_created` event delivered by `origin` to the stores.
 *
 * The caller has already gated the origin and normalized the message's assets.
 * Resolves once the message has been placed; that is immediate unless the
 * channel id is new to this client and the origin's DM list has to be read.
 */
export async function applyIncomingDmMessage(origin: string, message: DmMessageWithUser): Promise<void> {
  const known = resolveDmChannelId(message.dmChannelId);
  if (known) {
    deliverToConversation(origin, known, message);
    return;
  }

  await learnDmChannelsFromOrigin(origin);

  const learned = resolveDmChannelId(message.dmChannelId);
  if (learned) {
    deliverToConversation(origin, learned, message);
    return;
  }
  deliverAsNewConversation(origin, message);
}

/**
 * Apply a `dm_channel_created` event delivered by `origin` to the stores.
 *
 * The caller has already gated the origin, normalized member assets and
 * upserted the members into the user-view cache. A conversation already
 * listed from another origin is not added twice, but this origin's id for it
 * is recorded, so its later events route to the listed entry.
 */
export function applyIncomingDmChannel(origin: string, channel: DmChannel): void {
  const store = useSpaceStore.getState();
  const fid = channel.federatedId;
  if (fid) {
    store.recordDmAlternative(fid, origin, channel.id);
    if (store.dmChannels.some(dm => dm.federatedId === fid)) {
      // Listed from another origin already; if this is the home copy, it
      // takes over as the pinned one.
      repinDmsToHomeCopies();
      return;
    }
  }
  store.addDmChannel(channel, origin);
}
