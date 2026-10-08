import { getChannelOrigin, useSpaceStore } from '../stores/spaceStore';
import type { DmCallCredentials, DmCallRef, VoiceState } from '../stores/voiceStore';
import type { DmChannel } from '@backspace/shared';
import { wsSend } from '../hooks/useWebSocket';

/**
 * The origin a DM call's accept, decline and hang-up go to: the one that
 * rang it, or the conversation's own origin for a call this client placed or
 * joined there.
 */
export function dmCallOrigin(call: DmCallRef): string {
  return call.callOrigin ?? getChannelOrigin(call.dmChannelId ?? '');
}

/**
 * The id LiveKit connects the call under (`connectFn(id, true)`): the
 * conversation's id, or the call's key when the instance that rang it has no
 * copy of the conversation.
 */
export function dmCallRoomKey(call: DmCallRef): string {
  return call.dmChannelId ?? call.federatedCallId;
}

/**
 * The conversation this client can open for the call: its id on the
 * instance the call goes through, or, when that instance has no copy, the
 * copy another connection of this client has under the same key. Null when
 * the client has none.
 */
export function dmCallChannelId(
  call: DmCallRef,
  dmChannels: ReadonlyArray<Pick<DmChannel, 'id' | 'federatedId'>> = useSpaceStore.getState().dmChannels,
): string | null {
  if (call.dmChannelId) return call.dmChannelId;
  return dmChannels.find(d => d.federatedId === call.federatedCallId)?.id ?? null;
}

/** Every id the call is known by here: the conversation's id and the call's key. */
export function dmCallIds(call: DmCallRef): string[] {
  const ids: string[] = [];
  if (call.dmChannelId) ids.push(call.dmChannelId);
  if (call.federatedCallId) ids.push(call.federatedCallId);
  return ids;
}

/**
 * The origin of the voice the client is in: the voice channel's, or the DM
 * call's (`dmCallOrigin`). '' when it is in none, which is also the home
 * origin.
 */
export function voiceSessionOrigin(state: Pick<VoiceState, 'currentVoiceChannelId' | 'activeDmCall'>): string {
  if (state.currentVoiceChannelId) return getChannelOrigin(state.currentVoiceChannelId);
  if (state.activeDmCall) return dmCallOrigin(state.activeDmCall);
  return '';
}

/**
 * Hang up `call`, or cancel it while it rings: `dm_call_end` with the ids the
 * server needs, to the origin the call goes through. The one place a client
 * ends a DM call; it changes no local state.
 */
export function sendDmCallEnd(call: DmCallRef): void {
  wsSend(
    { type: 'dm_call_end', dmChannelId: call.dmChannelId, federatedCallId: call.federatedCallId },
    dmCallOrigin(call),
  );
}

/** Decline `call` while it rings: `dm_call_reject` to the origin that rang it. Changes no local state. */
export function sendDmCallReject(call: DmCallRef): void {
  wsSend(
    { type: 'dm_call_reject', dmChannelId: call.dmChannelId, federatedCallId: call.federatedCallId },
    dmCallOrigin(call),
  );
}

/**
 * The reference for a call an event names, rung or reported by `callOrigin`
 * (the origin the event came from, which the call's answer goes back to).
 * Null when the event names no call this client could answer: no
 * conversation id and no key.
 */
export function dmCallRefFrom(
  ids: { dmChannelId: string | null; federatedCallId?: string | null },
  callOrigin: string,
): DmCallRef | null {
  if (ids.dmChannelId) return { dmChannelId: ids.dmChannelId, federatedCallId: ids.federatedCallId ?? null, callOrigin };
  if (ids.federatedCallId) return { dmChannelId: null, federatedCallId: ids.federatedCallId, callOrigin };
  return null;
}

/** The LiveKit credentials an event brought, when it brought both. */
export function dmCallCredentialsFrom(livekitUrl: string | undefined, livekitToken: string | undefined): DmCallCredentials | null {
  return livekitUrl && livekitToken ? { url: livekitUrl, token: livekitToken } : null;
}
