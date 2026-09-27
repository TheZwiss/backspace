import type { InstanceStreamingLimits } from '@backspace/shared';
import { useVoiceStore } from '../stores/voiceStore';
import { useSpaceStore } from '../stores/spaceStore';
import { getStreamingLimits, selectStreamingLimits, useSettingsStore } from '../stores/settingsStore';

/**
 * Which instance's streaming limits a screen share obeys.
 *
 * A stream is carried by the LiveKit of the instance that issued the voice
 * token, which for a space channel is the instance the channel lives on
 * (`useLiveKit.connect` asks `getApiForOrigin(getChannelOrigin(channelId))`).
 * That instance's admin set the caps, so its document is the one that applies,
 * not the document of the instance the user registered on.
 *
 * A DM call has no `currentVoiceChannelId` and resolves to home (`''`). For a
 * federated DM call hosted elsewhere this is an approximation: the client may
 * hold no session on the host, so there is no document it could ask for.
 */
export function voiceHostOrigin(
  currentVoiceChannelId: string | null,
  channelOriginMap: ReadonlyMap<string, string>,
): string {
  if (!currentVoiceChannelId) return '';
  return channelOriginMap.get(currentVoiceChannelId) ?? '';
}

function currentVoiceHostOrigin(): string {
  return voiceHostOrigin(
    useVoiceStore.getState().currentVoiceChannelId,
    useSpaceStore.getState().channelOriginMap,
  );
}

/** Limits for the stream's host, with the defaults standing in while unknown. */
export function getStreamHostLimits(): InstanceStreamingLimits {
  return getStreamingLimits(currentVoiceHostOrigin());
}

/**
 * The host's origin and its document (null while unknown), for the quality
 * controls. Reactive in all three inputs: the voice channel, its origin, and
 * the documents themselves.
 */
export function useStreamHostLimits(): { origin: string; limits: InstanceStreamingLimits | null } {
  const voiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const origin = useSpaceStore((s) => voiceHostOrigin(voiceChannelId, s.channelOriginMap));
  const limits = useSettingsStore((s) => selectStreamingLimits(s, origin));
  return { origin, limits };
}

/**
 * Ask a remote host for its current document. Home is left alone: its
 * document arrives with every home `ready` and doubles as home's discovery
 * flags, which this must not overwrite.
 */
export function refreshStreamHostLimits(origin: string): Promise<void> {
  return useSettingsStore.getState().fetchStreamingLimitsFor(origin);
}
