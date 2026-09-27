import type { InstanceStreamingLimits } from '@backspace/shared';
import { useVoiceStore } from '../stores/voiceStore';
import {
  DEFAULT_STREAMING_LIMITS,
  getStreamingLimits,
  selectStreamingLimits,
  useSettingsStore,
} from '../stores/settingsStore';

/**
 * Which instance's streaming limits a screen share obeys: the one that issued
 * the LiveKit token, whose SFU carries the stream and whose admin set the caps.
 * `useLiveKit.connect` records its origin in `voiceStore.livekitHostOrigin`
 * (`''` = home) when it fetches the token, so nothing here guesses from the
 * channel. A token relayed from an instance this client has no session with
 * records null: that host's document cannot be fetched, and the defaults stand
 * in rather than home's document, which says nothing about another instance.
 */

/** Limits for the stream's host, with the defaults standing in while unknown. */
export function getStreamHostLimits(): InstanceStreamingLimits {
  const origin = useVoiceStore.getState().livekitHostOrigin;
  return origin === null ? DEFAULT_STREAMING_LIMITS : getStreamingLimits(origin);
}

/**
 * The host's origin and its document (null while unknown), for the quality
 * controls and the live-settings effect. Reactive in both the recorded host
 * and the documents, so limits that arrive late reach a running stream.
 */
export function useStreamHostLimits(): { origin: string | null; limits: InstanceStreamingLimits | null } {
  const origin = useVoiceStore((s) => s.livekitHostOrigin);
  const limits = useSettingsStore((s) => (origin === null ? null : selectStreamingLimits(s, origin)));
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
