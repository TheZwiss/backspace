import { useUIStore } from '../stores/uiStore';
import { useVoiceStore } from '../stores/voiceStore';
import { buildCallUndeliverableToast } from '../utils/callUndeliverableToast';
import type { WebSocketEventHandlers } from './webSocketEvents';
import { activePeerOrigins } from './webSocketFederationEvents';

/**
 * Tear down local state for a DM call that ended, was rejected, or became
 * terminally undeliverable. Clears the call UI/federation state, and tears
 * down the LiveKit session **only when the active voice connection still
 * belongs to the DM call**.
 *
 * The guard is load-bearing: `disconnectFn()` tears down whatever LiveKit room
 * is currently active, regardless of which channel it is. Once the user has
 * joined a *space* voice channel, `currentVoiceChannelId` is set and the active
 * room is the space channel — NOT the DM call (the two are mutually exclusive;
 * `setCurrentVoiceChannel` clears `activeDmCall`). A stale `dm_call_ended` echo
 * must never disconnect that space connection.
 *
 * This is exactly what happens to the **last** participant to leave a DM call
 * for a space channel: their `voice_join` empties the server-side DM room, the
 * server broadcasts `dm_call_ended` back to every DM member (including them),
 * and an unguarded `disconnectFn()` would tear down the space room they just
 * connected to — stranding the UI on "Connecting…" until a manual rejoin.
 */
export function teardownDmCall(): void {
  const voice = useVoiceStore.getState();
  voice.setIncomingCall(null);
  voice.setOutgoingCall(null);
  voice.setActiveDmCall(null);
  voice.clearFederatedCallData();
  // Never tear down a space voice connection in response to a DM-call signal.
  if (voice.disconnectFn && !voice.currentVoiceChannelId) voice.disconnectFn();
}

export const callEvents = {
  dm_call_incoming: (origin, event) => {
    const isHome = origin === '';
    if (!isHome && !activePeerOrigins.has(origin)) return;
    // Batch ALL call state into a single set() to prevent:
    // 1. Ringtone multiplication (multiple subscription triggers from separate set() calls)
    // 2. Stale callOrigin/federatedCallId from previous calls (always overwritten)
    // callOrigin = the WS origin that delivered this event, NOT event.callOrigin (the host).
    // Routing accept/reject through this WS ensures the message reaches a connected server,
    // which then relays to the host via S2S HTTP. Using event.callOrigin (the host URL)
    // would route through the multi-instance WS, which may not be connected.
    useVoiceStore.setState({
      incomingCall: {
        dmChannelId: event.dmChannelId ?? null,
        callerId: event.callerId,
        callerName: event.callerName,
      },
      federatedCallToken: event.livekitToken ?? null,
      federatedCallUrl: event.livekitUrl ?? null,
      federatedCallId: event.federatedCallId ?? null,
      callOrigin: origin,
    });
  },
  dm_call_accepted: (origin, event) => {
    const isHome = origin === '';
    if (!isHome && !activePeerOrigins.has(origin)) return;
    const { setIncomingCall, setOutgoingCall, outgoingCall, setActiveDmCall, connectFn, isLiveKitConnected } = useVoiceStore.getState();
    const wasOutgoingCall = !!outgoingCall;
    setIncomingCall(null);
    setOutgoingCall(null);

    // Only enter active call state if:
    // - We're the caller (wasOutgoingCall) → will connect via connectFn below
    // - We already connected to LiveKit (clicked accept in handleAccept)
    // Other instances of the same user must NOT enter call state — they'd show
    // "Connecting..." forever with no actual LiveKit connection.
    const callDmId = event.dmChannelId || event.federatedCallId || '';
    if (wasOutgoingCall || isLiveKitConnected) {
      setActiveDmCall({ dmChannelId: callDmId });
    }
    // The caller connects to the DM room. `wasOutgoingCall` alone identifies
    // the caller session (other sessions/tabs never set outgoingCall), and
    // `connect()` de-dupes an already-connected same room — so we must NOT
    // also gate on `!isLiveKitConnected`: a caller who is currently sitting in
    // a space voice channel is LiveKit-connected, and gating on it would skip
    // the DM connect entirely, stranding them in the space channel.
    if (connectFn && wasOutgoingCall && callDmId) {
      connectFn(callDmId, true).catch((err: unknown) => {
        console.error('[WS] DM call connect failed:', err);
      });
    }
  },
  dm_call_rejected: (origin, event) => {
    const isHome = origin === '';
    if (!isHome && !activePeerOrigins.has(origin)) return;
    teardownDmCall();
  },
  dm_call_ended: (origin, event) => {
    const isHome = origin === '';
    if (!isHome && !activePeerOrigins.has(origin)) return;
    teardownDmCall();
  },
  dm_call_undeliverable: (origin, event) => {
    const isHome = origin === '';
    if (!isHome && !activePeerOrigins.has(origin)) return;

    const { addToast } = useUIStore.getState();

    if (event.terminal) {
      // Tear down local outbound call state — mirrors dm_call_ended.
      teardownDmCall();
    }

    const msg = buildCallUndeliverableToast(event.failures, event.terminal, event.phase);
    addToast(msg, event.terminal ? 'warning' : 'info', 8_000);
  },
} satisfies WebSocketEventHandlers;
