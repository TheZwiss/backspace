import { useState, useCallback, useRef, useEffect } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  Participant,
  RemoteParticipant,
  RemoteTrackPublication,
  RemoteAudioTrack,
  ConnectionState,
  ConnectionQuality,
  LocalAudioTrack,
  LocalTrackPublication,
  DisconnectReason,
} from 'livekit-client';
import { getApiForOrigin, getChannelOrigin, getMyUserIdForOrigin, useSpaceStore } from '../stores/spaceStore';
import { wsSend } from './useWebSocket';
import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { useUIStore } from '../stores/uiStore';
import type { User } from '@backspace/shared';
import { broadcastVoiceStatus } from '../utils/voice';
import { consumeIntentionalCameraOff, markIntentionalCameraOff } from '../utils/voiceActions';
import { AudioManager } from '../audio/AudioManager';
import { SpeakingDetector } from '../audio/SpeakingDetector';
import {
  CAMERA_OVERDRIVE,
  buildScreenShareOptions,
  applyOverdrive,
  startScreenShare,
  stopScreenShare,
  handleScreenShareUnpublished,
  resolveNativeOverdrive,
} from '../utils/screenShare';
import { parseStreamWatch } from '../utils/streamWatchProtocol';
import { getMediaStreamTrack } from '../utils/livekitInternals';
import { deactivate as deactivateHwOverdrive } from '../utils/hwOverdrive';

let _activeRoom: Room | null = null;
let _publishedScreenShareCodec: 'vp9' | 'h264' | null = null;

export function getActiveRoom(): Room | null {
  return _activeRoom;
}

export interface ParticipantInfo {
  identity: string;
  userId: string;
  username: string;
  homeUserId: string | null;
  isMuted: boolean;
  isDeafened: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  isLocal: boolean;
  audioTrack: MediaStreamTrack | null;
  videoTrack: MediaStreamTrack | null;
  screenTrack: MediaStreamTrack | null;
  screenAudioTrack: MediaStreamTrack | null;
  lkVideoTrack: Track | null;   // LiveKit Track for attach/detach (adaptive stream)
  lkScreenTrack: Track | null;  // LiveKit Track for attach/detach (adaptive stream)
  cachedUser: User | null;   // Hydrated User from member lookup, carried forward across space switches
}

export interface UserTile {
  kind: 'user';
  key: string;                        // participant.identity
  participant: ParticipantInfo;
  videoTrack: MediaStreamTrack | null; // camera only
  audioTrack: MediaStreamTrack | null; // mic
  lkVideoTrack: Track | null;         // LiveKit Track for attach/detach
}

export interface StreamTile {
  kind: 'stream';
  key: string;                        // `${identity}:stream`
  participant: ParticipantInfo;
  screenTrack: MediaStreamTrack | null;
  screenAudioTrack: MediaStreamTrack | null;
  lkScreenTrack: Track | null;        // LiveKit Track for attach/detach
}

export type GridTile = UserTile | StreamTile;

export function deriveGridTiles(participants: ParticipantInfo[]): GridTile[] {
  const tiles: GridTile[] = [];
  for (const p of participants) {
    const hasLiveVideo = p.isCameraOn && p.videoTrack?.readyState === 'live';
    tiles.push({
      kind: 'user',
      key: p.identity,
      participant: p,
      videoTrack: hasLiveVideo ? p.videoTrack : null,
      audioTrack: p.audioTrack,
      lkVideoTrack: hasLiveVideo ? p.lkVideoTrack : null,
    });
    if (p.isScreenSharing) {
      tiles.push({
        kind: 'stream',
        key: `${p.identity}:stream`,
        participant: p,
        screenTrack: p.screenTrack,
        screenAudioTrack: p.screenAudioTrack,
        lkScreenTrack: p.lkScreenTrack,
      });
    }
  }
  return tiles;
}

export function setStreamSubscription(room: Room | null, targetIdentity: string, subscribed: boolean) {
  if (!room) return;
  const rp = room.remoteParticipants.get(targetIdentity);
  if (!rp) return;
  rp.trackPublications.forEach((pub) => {
    if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) {
      (pub as RemoteTrackPublication).setSubscribed(subscribed);
    }
  });
}

export function setCameraSubscription(room: Room | null, targetIdentity: string, subscribed: boolean) {
  if (!room) return;
  const rp = room.remoteParticipants.get(targetIdentity);
  if (!rp) return;
  rp.trackPublications.forEach((pub) => {
    if (pub.source === Track.Source.Camera) {
      (pub as RemoteTrackPublication).setSubscribed(subscribed);
    }
  });
}

export function parseIdentity(identity: string): { userId: string; username: string } {
  const parts = identity.split(':');
  return { userId: parts[0] ?? identity, username: parts[1] ?? identity };
}

let _connectGeneration = 0;

/** Null-safe Room.disconnect() wrapper — lets the SDK tear down its own internals cleanly. */
function destroyRoom(room: Room | null): Promise<void> | void {
  if (!room) return;
  return room.disconnect();
}

export function useLiveKit() {
  const [room, setRoom] = useState<Room | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.Disconnected);
  const [connectedChannelId, setConnectedChannelId] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const roomRef = useRef<Room | null>(null);
  const connectedChannelRef = useRef<string | null>(null);
  const switchCameraGenRef = useRef(0);
  
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const isCameraOn = useVoiceStore((s) => s.isCameraOn);
  const isScreenSharing = useVoiceStore((s) => s.isScreenSharing);
  const screenShareConfig = useVoiceStore((s) => s.screenShareConfig);
  const hwOverdrive = useVoiceStore((s) => s.hwOverdrive);
  const voiceUserStates = useVoiceStore((s) => s.voiceUserStates);
  const spaceMutedUserIds = useVoiceStore((s) => s.spaceMutedUserIds);
  const spaceDeafenedUserIds = useVoiceStore((s) => s.spaceDeafenedUserIds);
  const permissionMutedUserIds = useVoiceStore((s) => s.permissionMutedUserIds);
  const inputVolume = useVoiceStore((s) => s.inputVolume);
  const inputDeviceId = useVoiceStore((s) => s.inputDeviceId);
  const cameraDeviceId = useVoiceStore((s) => s.cameraDeviceId);
  const echoCancellation = useVoiceStore((s) => s.echoCancellation);
  const noiseSuppression = useVoiceStore((s) => s.noiseSuppression);
  const autoGainControl = useVoiceStore((s) => s.autoGainControl);
  const rnnoiseEnabled = useVoiceStore((s) => s.rnnoiseEnabled);

  const lastMicGenRef = useRef(0);

  const updateParticipants = useCallback(() => {
    const r = roomRef.current;
    if (!r) return;

    // Carry-forward: snapshot previous participants for cachedUser preservation
    const prevParticipants = useVoiceStore.getState().participants;
    const prevCacheMap = new Map<string, User | null>();
    for (const prev of prevParticipants) {
      prevCacheMap.set(prev.identity, prev.cachedUser);
    }

    const allParticipants: ParticipantInfo[] = [];
    const processParticipant = (p: Participant, isLocal: boolean) => {
      if (!p.identity) return;
      const { userId: rawId, username } = parseIdentity(p.identity);

      // Resolve identity: for federated calls rawId may be homeUserId from another instance.
      // Check DM members for a user whose homeUserId matches.
      let userId = rawId;
      const activeDmCall = useVoiceStore.getState().activeDmCall;
      if (activeDmCall) {
        const dmChannels = useSpaceStore.getState().dmChannels;
        const dmChannel = dmChannels.find(d => d.id === activeDmCall.dmChannelId);
        if (dmChannel) {
          const match = dmChannel.members.find(m => m.homeUserId === rawId || m.id === rawId);
          if (match) userId = match.id;
        }
      }

      const memberMatch = useSpaceStore.getState().members.find(m => m.userId === userId);
      let cachedUser: User | null;
      let homeUserId: string | null;

      if (memberMatch) {
        // Fresh data available — use and update cache
        cachedUser = memberMatch.user as User;
        homeUserId = memberMatch.user.homeUserId ?? null;
      } else if (isLocal) {
        // Local user safety net — authStore is always available
        cachedUser = useAuthStore.getState().user;
        homeUserId = cachedUser?.homeUserId ?? null;
      } else {
        // Space switched — carry forward from previous cycle
        cachedUser = prevCacheMap.get(p.identity) ?? null;
        homeUserId = cachedUser?.homeUserId ?? null;
      }
      let audioTrack: MediaStreamTrack | null = null;
      let videoTrack: MediaStreamTrack | null = null;
      let screenTrack: MediaStreamTrack | null = null;
      let screenAudioTrack: MediaStreamTrack | null = null;
      let lkVideoTrack: Track | null = null;
      let lkScreenTrack: Track | null = null;
      let hasScreenSharePublication = false;
      let hasCameraPublication = false;
      p.trackPublications.forEach((pub) => {
        // Detect screen share publication even if unsubscribed
        if (pub.source === Track.Source.ScreenShare) hasScreenSharePublication = true;
        // Detect camera publication even if unsubscribed (for unwatched cameras)
        if (pub.source === Track.Source.Camera) hasCameraPublication = true;

        const track = pub.track;
        if (!track) return;
        // Strict check: Track must be subscribed AND not muted to be considered "active"
        if (pub.isMuted) return;
        if (!isLocal && !pub.isSubscribed) return;

        const mt = track.mediaStreamTrack;
        if (!mt || mt.readyState !== 'live') return;

        if (pub.source === Track.Source.Microphone) audioTrack = mt;
        else if (pub.source === Track.Source.Camera && p.isCameraEnabled) { videoTrack = mt; lkVideoTrack = track; }
        else if (pub.source === Track.Source.ScreenShare) { screenTrack = mt; lkScreenTrack = track; }
        else if (pub.source === Track.Source.ScreenShareAudio) screenAudioTrack = mt;
      });

      const userState = useVoiceStore.getState().voiceUserStates.get(userId);
      let isPartDeafened = false;
      let isPartMuted = !p.isMicrophoneEnabled;

      if (isLocal) {
        // Compute effective state: user intent || server enforcement
        const vs = useVoiceStore.getState();
        const cvId = vs.currentVoiceChannelId;
        const localOrigin = cvId ? getChannelOrigin(cvId) : '';
        const localMyId = cvId ? getMyUserIdForOrigin(localOrigin) : undefined;
        const localSpaceId = cvId ? useSpaceStore.getState().channelToSpaceMap.get(cvId) : null;
        const localKey = (localSpaceId && localMyId) ? `${localSpaceId}:${localMyId}` : '';
        isPartMuted = vs.isMuted || vs.spaceMutedUserIds.has(localKey) || vs.permissionMutedUserIds.has(localKey);
        isPartDeafened = vs.isDeafened || vs.spaceDeafenedUserIds.has(localKey);
      } else {
        isPartDeafened = userState?.isDeafened ?? useVoiceStore.getState().deafenedUserIds.has(userId);
        if (userState) isPartMuted = userState.isMuted;
      }

      allParticipants.push({
        identity: p.identity,
        userId,
        username,
        homeUserId,
        cachedUser,
        isMuted: isPartMuted,
        isDeafened: isPartDeafened,
        isCameraOn: hasCameraPublication && p.isCameraEnabled, // True even when unsubscribed
        isScreenSharing: hasScreenSharePublication, // True even when unsubscribed
        isLocal,
        audioTrack,
        videoTrack,
        screenTrack,
        screenAudioTrack,
        lkVideoTrack,
        lkScreenTrack,
      });
    };
    processParticipant(r.localParticipant, true);
    r.remoteParticipants.forEach((p) => processParticipant(p, false));
    useVoiceStore.getState().setParticipants(allParticipants);
    SpeakingDetector.getInstance().syncTracks(allParticipants);
  }, []);

  const handleDataReceived = useCallback((payload: Uint8Array, participant?: RemoteParticipant) => {
    // Try the stream_watch protocol first (typed parser; returns null on non-matches).
    if (participant) {
      const sw = parseStreamWatch(payload);
      if (sw) {
        // sw.target is the streamer's bare userId. participant.identity is the
        // viewer's full LiveKit identity ("userId:username"); we key by identity
        // so ParticipantDisconnected can evict cleanly.
        useVoiceStore.getState().recordStreamWatch(sw.target, participant.identity, sw.watching);
        return;
      }
    }
    try {
      const text = new TextDecoder().decode(payload);
      const msg = JSON.parse(text);
      if (msg.type === 'deafen' && participant) {
        const { userId } = parseIdentity(participant.identity);
        useVoiceStore.getState().setUserDeafened(userId, msg.deafened === true);
        updateParticipants();
      }
    } catch { }
  }, [updateParticipants]);

  // Handle Input Device & Mute Logic via AudioManager
  // Mute uses setMicrophoneEnabled(false) to keep the track published (silence frames)
  // instead of unpublishTrack() which tears down the WebRTC transport.
  // This preserves the Web Audio pipeline for future AudioWorklet nodes (e.g. RNNoise).
  useEffect(() => {
    const r = roomRef.current;
    if (!r || !isConnected) return;

    // Compute effective mute/deafen: user intent || server enforcement
    const vs = useVoiceStore.getState();
    const cvId = vs.currentVoiceChannelId;
    const effOrigin = cvId ? getChannelOrigin(cvId) : '';
    const effMyId = cvId ? getMyUserIdForOrigin(effOrigin) : undefined;
    const effSpaceId = cvId ? useSpaceStore.getState().channelToSpaceMap.get(cvId) : null;
    const effKey = (effSpaceId && effMyId) ? `${effSpaceId}:${effMyId}` : '';
    const effectiveMuted = isMuted || spaceMutedUserIds.has(effKey) || permissionMutedUserIds.has(effKey);
    const effectiveDeafened = isDeafened || spaceDeafenedUserIds.has(effKey);

    const syncMic = async () => {
      try {
        const audioManager = AudioManager.getInstance();

        // Sync voice processing settings to AudioManager
        audioManager.setVoiceProcessing({ echoCancellation, noiseSuppression, autoGainControl });
        await audioManager.setRnnoiseEnabled(rnnoiseEnabled);

        const micPub = r.localParticipant.getTrackPublications()
          .find(p => p.source === Track.Source.Microphone);

        // If effectively muted or deafened, mute the track in-place (keep it published)
        if (effectiveMuted || effectiveDeafened) {
          if (micPub?.track && !micPub.isMuted) {
            await r.localParticipant.setMicrophoneEnabled(false);
          }
          return;
        }

        // Not muted — ensure mic is published and live
        await audioManager.setInputDevice(inputDeviceId);
        audioManager.setInputVolume(inputVolume);

        const currentGen = audioManager.getStreamGeneration();

        if (micPub?.track) {
          // Track already published — check if it's still current
          if (micPub.track.mediaStreamTrack?.readyState === 'live' && lastMicGenRef.current === currentGen) {
            // Current and live — just unmute if needed
            if (micPub.isMuted) {
              await r.localParticipant.setMicrophoneEnabled(true);
            }
            return;
          }
          // Track is stale (device or constraint change) — replace it
          await r.localParticipant.unpublishTrack(micPub.track as LocalAudioTrack);
        }

        // Publish fresh track from AudioManager pipeline
        const audioTrack = audioManager.getFreshTrack();
        if (!audioTrack) return;

        console.log('[LiveKit] Publishing fresh microphone track (gen:', currentGen, ')');
        await r.localParticipant.publishTrack(audioTrack, {
          name: 'microphone',
          source: Track.Source.Microphone,
        });
        lastMicGenRef.current = currentGen;

      } catch (err) {
        console.error('[LiveKit] Failed to sync mic state:', err);
      }
    };

    syncMic();

    // Re-sync when AudioManager resumes
    const unsubscribe = AudioManager.getInstance().onResumed(() => {
      syncMic();
    });

    return () => {
      unsubscribe();
    };
  }, [isMuted, isDeafened, spaceMutedUserIds, spaceDeafenedUserIds, permissionMutedUserIds, inputDeviceId, inputVolume, isConnected, echoCancellation, noiseSuppression, autoGainControl, rnnoiseEnabled]);

  // Hot-swap the camera source when cameraDeviceId changes mid-call.
  // Compares against the published track's actual deviceId (getSettings().deviceId)
  // rather than a memoised previous store value, so the null → explicit-same-device
  // transition is a correct no-op.
  useEffect(() => {
    const r = roomRef.current;
    if (!r || !isConnected || !isCameraOn) return;

    const camPub = r.localParticipant.getTrackPublications()
      .find(p => p.source === Track.Source.Camera);
    if (!camPub?.track) return;

    const currentDeviceId = camPub.track.mediaStreamTrack?.getSettings().deviceId;
    const target = cameraDeviceId;

    if (target === null) return;            // "Auto" never force-switches a live publication
    if (currentDeviceId === target) return; // already on target

    const myGen = ++switchCameraGenRef.current;

    // Race semantics: if the effect re-fires while this IIFE is in flight
    // (rapid dropdown changes), the newer firing will increment the gen.
    // This IIFE's catch then no-ops its store rollback — the newer attempt
    // owns the canonical store state.
    (async () => {
      const prev = currentDeviceId ?? null;
      try {
        await r.switchActiveDevice('videoinput', target);
      } catch (err) {
        console.error('[LiveKit] Camera hot-swap failed:', err);
        // A newer device-switch attempt has superseded ours. Don't write stale
        // rollback state; let the newer attempt's outcome stand.
        if (myGen !== switchCameraGenRef.current) {
          useUIStore.getState().addToast('Could not switch camera', 'warning');
          return;
        }
        const stillLive = camPub.track?.mediaStreamTrack?.readyState === 'live';
        if (stillLive && prev) {
          useVoiceStore.getState().setCameraDeviceId(prev);
        } else if (stillLive) {
          useVoiceStore.getState().setCameraDeviceId(null);
        } else {
          // Track is dead — disable the camera entirely. Mark the flag now to
          // suppress the already-queued `ended` event on the dead track.
          markIntentionalCameraOff();
          // Re-mark immediately before the disable: LiveKit may synthesize a
          // second `ended` event during teardown, and the flag is consumed once.
          // markIntentionalCameraOff is idempotent.
          markIntentionalCameraOff();
          await r.localParticipant.setCameraEnabled(false).catch(() => {});
          useVoiceStore.setState({ isCameraOn: false });
          broadcastVoiceStatus();
        }
        useUIStore.getState().addToast('Could not switch camera', 'warning');
      }
    })();
  }, [cameraDeviceId, isCameraOn, isConnected]);

  const connect = useCallback(async (channelId: string, isDm?: boolean) => {
    const storedId = isDm ? `dm-${channelId}` : channelId;
    if (connectedChannelRef.current === storedId && roomRef.current?.state === ConnectionState.Connected) return;

    // Register voice state with the WS server after LiveKit connects (not for DM calls)
    const registerWithServer = () => {
      if (isDm) return;
      const origin = getChannelOrigin(channelId);
      wsSend({ type: 'voice_join', channelId }, origin);
      broadcastVoiceStatus(origin);
    };
    const gen = ++_connectGeneration;

    // Ensure AudioContext is created and resumed before tracks arrive
    await AudioManager.getInstance().resumeContext();

    // 1. Reset state immediately to reflect "Loading/Switching" in UI
    SpeakingDetector.getInstance().clear();
    setRoom(null);
    useVoiceStore.getState().setParticipants([]);
    useVoiceStore.getState().setSpeakingParticipants(new Set());
    setIsConnected(false);
    setIsConnecting(true);
    setConnectionState(ConnectionState.Connecting);
    setConnectionError(null);
    setConnectedChannelId(null); // Clear this so AppLayout knows we are transitioning

    useVoiceStore.getState().setConnectionError(null);
    useVoiceStore.getState().setIsLiveKitConnected(false);
    useVoiceStore.getState().setConnectionQuality('unknown');

    // 2. Strictly disconnect previous room (Local Ref OR Global Ref)
    // This handles cases where AppLayout might have remounted, losing roomRef but leaving _activeRoom alive.
    const roomToDisconnect = roomRef.current || _activeRoom;
    
    if (roomToDisconnect) {
      try {
        console.log('[LiveKit] Destroying previous room:', roomToDisconnect.name);
        await destroyRoom(roomToDisconnect);
      } catch (err) {
        console.warn('Error disconnecting from previous room:', err);
      }
      roomRef.current = null;
      _activeRoom = null;
    }
    
    try {
      let token: string;
      let url: string;

      // For federated calls, use the stored token from S2S relay
      const { federatedCallToken, federatedCallUrl, clearFederatedCallData } = useVoiceStore.getState();
      if (isDm && federatedCallToken && federatedCallUrl) {
        token = federatedCallToken;
        url = federatedCallUrl;
        clearFederatedCallData();
      } else {
        const client = getApiForOrigin(getChannelOrigin(channelId));
        const resp = isDm ? await client.livekit.dmToken(channelId) : await client.livekit.token(channelId);
        token = resp.token;
        url = resp.url;
      }
      if (gen !== _connectGeneration) return;
      const newRoom = new Room({ adaptiveStream: true, dynacast: true, publishDefaults: { videoCodec: 'h264', simulcast: true } });
      roomRef.current = newRoom;

      const guardedUpdate = () => { if (roomRef.current === newRoom) updateParticipants(); };
      newRoom.on(RoomEvent.ParticipantConnected, (participant) => {
        guardedUpdate();
        // Notify new participant of our effective deafen state
        const vsConn = useVoiceStore.getState();
        const cvIdConn = vsConn.currentVoiceChannelId;
        const connOrigin = cvIdConn ? getChannelOrigin(cvIdConn) : '';
        const connMyId = cvIdConn ? getMyUserIdForOrigin(connOrigin) : undefined;
        const connSpaceId = cvIdConn ? useSpaceStore.getState().channelToSpaceMap.get(cvIdConn) : null;
        const connKey = (connSpaceId && connMyId) ? `${connSpaceId}:${connMyId}` : '';
        const effDeaf = vsConn.isDeafened || vsConn.spaceDeafenedUserIds.has(connKey);
        if (effDeaf) {
          const encoder = new TextEncoder();
          newRoom.localParticipant.publishData(
            encoder.encode(JSON.stringify({ type: 'deafen', deafened: true })),
            { reliable: true }
          ).catch(() => { });
        }
      });
      newRoom.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
        useVoiceStore.getState().evictWatcher(participant.identity);
        guardedUpdate();
        // Clean up stale WS-based voice status for the departed participant
        const { userId } = parseIdentity(participant.identity);
        useVoiceStore.getState().clearVoiceUserStatus(userId);
      });
      newRoom.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        // LiveKit auto-attaches a hidden <audio> element for subscribed audio tracks.
        // GlobalAudioRenderer is the sole audio playback path with volume/attenuation/boost.
        // Detach LiveKit's internal element to prevent double-playback.
        if (track.kind === Track.Kind.Audio) {
          (track as RemoteAudioTrack).detach();
        }
        guardedUpdate();
      });
      newRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          (track as RemoteAudioTrack).detach();
        }
        guardedUpdate();
      });
      newRoom.on(RoomEvent.LocalTrackPublished, (publication: LocalTrackPublication) => {
        if (publication.source === Track.Source.ScreenShare) {
          const { userId } = parseIdentity(newRoom.localParticipant.identity);
          useVoiceStore.getState().watchStream(userId);
        }
        if (publication.source === Track.Source.Camera) {
          const mst = publication.track?.mediaStreamTrack;
          if (mst) {
            // Replace any prior listener — on a re-publish the underlying track is new.
            mst.onended = async () => {
              // User-initiated camera-off → skip the probe + toast entirely.
              if (consumeIntentionalCameraOff()) return;
              // Room is tearing down or has been replaced → skip.
              if (roomRef.current !== newRoom) return;

              // Re-probe getUserMedia to distinguish hardware unplug from
              // OS-level permission revoke. Keep the probe short and tolerant.
              const deviceId = useVoiceStore.getState().cameraDeviceId;
              let copy = 'Camera unavailable';
              try {
                const probe = await navigator.mediaDevices.getUserMedia({
                  video: deviceId ? { deviceId: { exact: deviceId } } : true,
                });
                probe.getTracks().forEach(t => t.stop());
                // Probe succeeded — reason is unknown; keep generic copy.
              } catch (err: any) {
                if (err?.name === 'NotAllowedError') copy = 'Camera permission was revoked';
                else if (err?.name === 'NotFoundError') copy = 'Camera disconnected';
                // Any other error → keep generic copy.
              }

              // The probe is async and may have taken time (especially if the
              // browser surfaced a permission prompt). If the user disconnected
              // while the probe was in flight, `roomRef.current` is no longer
              // `newRoom` — silently no-op so we don't mutate state or surface
              // a toast for a session the user has already left.
              if (roomRef.current !== newRoom) return;

              // Tear down camera state via the unified path. Mark intentional so
              // the disable's own track-end doesn't recurse into this handler.
              markIntentionalCameraOff();
              await roomRef.current.localParticipant.setCameraEnabled(false).catch(() => {});
              useVoiceStore.setState({ isCameraOn: false });
              broadcastVoiceStatus();
              useUIStore.getState().addToast(copy, 'warning');
            };
          }
        }
        if (publication.source === Track.Source.Microphone) {
          const mst = publication.track?.mediaStreamTrack;
          if (mst) {
            mst.onended = async () => {
              // The mic track we publish is the *cloned* output of the AudioManager
              // pipeline (see AudioManager.getFreshTrack). It can end for two
              // distinct reasons:
              //   (a) The underlying upstream getUserMedia track ended (unplug,
              //       OS revoke). The clone goes too.
              //   (b) syncMic called unpublishTrack() during a deliberate
              //       republish (device change, RNNoise toggle). In that case
              //       the user did NOT lose audio — a fresh track is incoming.
              //
              // Distinguishing (a) from (b): inspect the AudioManager's current
              // upstream stream. If it's null or non-active AND the room is
              // still ours, we're in case (a).
              if (roomRef.current !== newRoom) return;
              const am = AudioManager.getInstance();
              if (am.hasActiveStream()) return; // case (b) — pipeline is alive

              // Probe getUserMedia to distinguish unplug vs revoke vs unavailable.
              const deviceId = useVoiceStore.getState().inputDeviceId;
              let copy = 'Microphone unavailable';
              try {
                const probe = await navigator.mediaDevices.getUserMedia({
                  audio: deviceId === 'default' ? true : { deviceId: { exact: deviceId } },
                });
                probe.getTracks().forEach(t => t.stop());
                // Probe succeeded — device is back. Try to re-acquire silently.
                if (roomRef.current !== newRoom) return;
                try {
                  await am.setInputDevice(deviceId);
                  // syncMic effect re-publishes when stream generation bumps.
                  return;
                } catch {
                  copy = 'Microphone could not be restored';
                }
              } catch (err: any) {
                if (err?.name === 'NotAllowedError') copy = 'Microphone permission was revoked';
                else if (err?.name === 'NotFoundError') {
                  // The configured device disappeared. Fall back to default if
                  // the user wasn't already on it.
                  if (deviceId !== 'default') {
                    useVoiceStore.getState().setInputDevice('default');
                    copy = 'Microphone disconnected — switched to system default';
                  } else {
                    copy = 'Microphone disconnected';
                  }
                }
              }

              if (roomRef.current !== newRoom) return;
              useUIStore.getState().addToast(copy, 'warning');
            };
          }
        }
        guardedUpdate();
      });
      newRoom.on(RoomEvent.LocalTrackUnpublished, (publication: LocalTrackPublication) => {
        if (publication.source === Track.Source.ScreenShare) {
          const { userId } = parseIdentity(newRoom.localParticipant.identity);
          useVoiceStore.getState().unwatchStream(userId);
          // OS-level "Stop sharing" fires this without going through stopScreenShare
          handleScreenShareUnpublished();
        }
        guardedUpdate();
      });
      newRoom.on(RoomEvent.TrackMuted, guardedUpdate);
      newRoom.on(RoomEvent.TrackUnmuted, guardedUpdate);
      newRoom.on(RoomEvent.ParticipantMetadataChanged, guardedUpdate);
      newRoom.on(RoomEvent.TrackPublished, (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (
          publication.source !== Track.Source.ScreenShare &&
          publication.source !== Track.Source.ScreenShareAudio
        ) {
          publication.setSubscribed(true);
        }
        guardedUpdate();
      });
      newRoom.on(RoomEvent.TrackUnpublished, (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (publication.source === Track.Source.ScreenShare) {
          const { userId } = parseIdentity(participant.identity);
          const state = useVoiceStore.getState();
          state.unwatchStream(userId);
          state.clearStreamVolume(userId);
          state.clearStreamMute(userId);
        }
        guardedUpdate();
      });
      newRoom.on(RoomEvent.DataReceived, handleDataReceived);
      newRoom.on(RoomEvent.ConnectionQualityChanged, (quality: ConnectionQuality, participant: Participant) => {
        if (participant.identity === newRoom.localParticipant.identity) {
          useVoiceStore.getState().setConnectionQuality(quality as any);
        }
      });
      newRoom.on(RoomEvent.ConnectionStateChanged, (state) => {
        if (roomRef.current === newRoom) {
          setConnectionState(state);
          const connected = state === ConnectionState.Connected;
          const connecting = state === ConnectionState.Connecting || state === ConnectionState.Reconnecting;

          setIsConnected(connected);
          setIsConnecting(connecting);

          useVoiceStore.getState().setIsLiveKitConnected(connected);

          if (connected) {
            // On LiveKit reconnect, re-register with WS server (server may have restarted)
            if (connectedChannelRef.current) {
              registerWithServer();
            }
            updateParticipants();
          }
        }
      });
      newRoom.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (roomRef.current !== newRoom) return;
        SpeakingDetector.getInstance().clear();
        setConnectionState(ConnectionState.Disconnected);
        setConnectedChannelId(null);
        roomRef.current = null; _activeRoom = null; setIsConnected(false); setRoom(null);
        // Batch participants + connected into one setState to prevent SoundController
        // from seeing intermediate states (e.g., participants empty but still "connected"
        // → triggers user_leave sound before the disconnect sound).
        useVoiceStore.getState().setSpeakingParticipants(new Set());
        useVoiceStore.setState({ participants: [], isLiveKitConnected: false });

        // Non-client disconnect (identity collision, server shutdown, kicked, etc.)
        // → clear voice intent so AppLayout doesn't auto-retry into an infinite loop.
        // Client-initiated disconnects already clear this via leaveVoice() / VoiceControlBar.
        if (reason !== undefined && reason !== DisconnectReason.CLIENT_INITIATED) {
          useVoiceStore.getState().handleForceDisconnect();
        }
      });

      await newRoom.connect(url, token, { autoSubscribe: false });
      if (gen !== _connectGeneration) { destroyRoom(newRoom); return; }
      _activeRoom = newRoom;
      connectedChannelRef.current = storedId;
      setConnectedChannelId(storedId);
      setRoom(newRoom);
      setIsConnected(true);
      useVoiceStore.getState().setIsLiveKitConnected(true);

      // Tell WS server we're in the voice channel now that LiveKit is connected
      registerWithServer();

      updateParticipants();

      // Subscribe to non-screen-share tracks from existing participants (safety net)
      newRoom.remoteParticipants.forEach((rp) => {
        rp.trackPublications.forEach((pub) => {
          if (
            pub.source !== Track.Source.ScreenShare &&
            pub.source !== Track.Source.ScreenShareAudio
          ) {
            (pub as RemoteTrackPublication).setSubscribed(true);
          }
        });
      });

      // Initial mute state check
      const { isMuted: wasMuted, isDeafened: wasDeafened } = useVoiceStore.getState();
      useVoiceStore.setState({ isCameraOn: false, isScreenSharing: false });
      
      if (wasDeafened) {
        newRoom.remoteParticipants.forEach((p) => p.setVolume(0));
      }
      
      updateParticipants();
    } catch (err) { if (gen === _connectGeneration) { setConnectionError('Failed to connect'); useVoiceStore.getState().setConnectionError('Failed to connect'); useVoiceStore.getState().leaveVoice(); } }
    finally { if (gen === _connectGeneration) setIsConnecting(false); }
  }, [updateParticipants, handleDataReceived]);

  const disconnect = useCallback(async () => {
    _connectGeneration++;
    SpeakingDetector.getInstance().clear();
    deactivateHwOverdrive();
    connectedChannelRef.current = null;
    setConnectedChannelId(null);
    if (roomRef.current) {
      // Null out roomRef BEFORE destroying so that guardedUpdate() skips
      // during teardown. Without this, ParticipantDisconnected events fire
      // before RoomEvent.Disconnected, calling updateParticipants while
      // isLiveKitConnected is still true — SoundController plays user_leave
      // for departing participants alongside the disconnect sound.
      const roomToDestroy = roomRef.current;
      roomRef.current = null;
      _activeRoom = null;
      await destroyRoom(roomToDestroy);
      setRoom(null);
      setIsConnected(false);
      setIsConnecting(false);
      setConnectionState(ConnectionState.Disconnected);
      useVoiceStore.getState().setSpeakingParticipants(new Set());
      useVoiceStore.setState({ participants: [], isLiveKitConnected: false });
    }
  }, []);

  const toggleMic = useCallback(async () => { 
    await AudioManager.getInstance().resumeContext();
    useVoiceStore.getState().toggleMic();
  }, []);

  const toggleScreenShare = useCallback(async () => {
    if (!roomRef.current) return;
    if (!useVoiceStore.getState().isScreenSharing) {
      await startScreenShare(roomRef.current);
    } else {
      await stopScreenShare(roomRef.current);
    }
    updateParticipants();
  }, [updateParticipants]);

  useEffect(() => {
    updateParticipants();
  }, [voiceUserStates, isMuted, isDeafened, spaceMutedUserIds, spaceDeafenedUserIds, permissionMutedUserIds, updateParticipants]);

  useEffect(() => {
    if (!room) return;
    const updateActiveTracks = async () => {
      if (isScreenSharing) {
        const opts = buildScreenShareOptions(screenShareConfig);

        // Codec changed mid-stream — must restart (codec is baked into SDP negotiation)
        if (_publishedScreenShareCodec && _publishedScreenShareCodec !== opts.publish.videoCodec) {
          _publishedScreenShareCodec = null;
          // Preserve hwOverdrive across restart — stopScreenShare() resets it,
          // but the user's intent (the pill they just clicked) must survive.
          const preserveHwOverdrive = useVoiceStore.getState().hwOverdrive;
          await stopScreenShare(room);
          if (preserveHwOverdrive) useVoiceStore.setState({ hwOverdrive: true });
          setTimeout(() => startScreenShare(room).catch(() => {}), 200);
          return;
        }

        const screenPub = room.localParticipant.getTrackPublications().find(p => p.source === Track.Source.ScreenShare);
        if (screenPub?.videoTrack) {
          // Track the published codec for mid-stream change detection
          if (!_publishedScreenShareCodec) {
            _publishedScreenShareCodec = opts.publish.videoCodec;
          }
          const mediaTrack = getMediaStreamTrack(screenPub.videoTrack);
          if (mediaTrack) {
            if (opts.capture.width > 0 && opts.capture.height > 0) {
              // Standard mode: apply resolution + frameRate together
              await mediaTrack.applyConstraints({ width: { ideal: opts.capture.width }, height: { ideal: opts.capture.height }, frameRate: { ideal: opts.capture.frameRate, min: 15 } });
            } else {
              // Native mode: apply frameRate only — never pass 0 to width/height
              await mediaTrack.applyConstraints({ frameRate: { ideal: opts.capture.frameRate, min: 15 } });
            }
            mediaTrack.contentHint = opts.contentHint;
          }
          // For native mode, recompute overdrive bitrate from actual track dimensions
          resolveNativeOverdrive(mediaTrack ?? null, screenShareConfig, opts);
          await applyOverdrive(room, Track.Source.ScreenShare, opts.overdrive);
        }
      } else {
        // Screen share stopped — clear published codec tracker
        _publishedScreenShareCodec = null;
      }
      if (isCameraOn) { await applyOverdrive(room, Track.Source.Camera, CAMERA_OVERDRIVE); }
    };
    updateActiveTracks().catch(() => {});
  }, [room, screenShareConfig, isScreenSharing, isCameraOn, hwOverdrive]);

  useEffect(() => {
    return () => { _connectGeneration++; SpeakingDetector.getInstance().clear(); deactivateHwOverdrive(); if (roomRef.current) { destroyRoom(roomRef.current); roomRef.current = null; _activeRoom = null; } };
  }, []);


  return { room, isConnected, isConnecting, connectionState, connectedChannelId, connectionError, connect, disconnect, toggleMic, toggleScreenShare };
}
