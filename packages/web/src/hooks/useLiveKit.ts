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
} from 'livekit-client';
import { getApiForOrigin, getChannelOrigin, useSpaceStore } from '../stores/spaceStore';
import { wsSend } from './useWebSocket';
import { useVoiceStore } from '../stores/voiceStore';
import { AudioManager } from '../audio/AudioManager';
import { SpeakingDetector } from '../audio/SpeakingDetector';
import {
  CAMERA_PRESET,
  CAMERA_OVERDRIVE,
  buildScreenShareOptions,
  applyOverdrive,
  startScreenShare,
  stopScreenShare,
  handleScreenShareUnpublished,
} from '../utils/screenShare';
import { getMediaStreamTrack } from '../utils/livekitInternals';

let _activeRoom: Room | null = null;

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

function parseIdentity(identity: string): { userId: string; username: string } {
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
  
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const isCameraOn = useVoiceStore((s) => s.isCameraOn);
  const isScreenSharing = useVoiceStore((s) => s.isScreenSharing);
  const screenShareConfig = useVoiceStore((s) => s.screenShareConfig);
  const voiceUserStates = useVoiceStore((s) => s.voiceUserStates);
  const inputVolume = useVoiceStore((s) => s.inputVolume);
  const inputDeviceId = useVoiceStore((s) => s.inputDeviceId);
  const echoCancellation = useVoiceStore((s) => s.echoCancellation);
  const noiseSuppression = useVoiceStore((s) => s.noiseSuppression);
  const autoGainControl = useVoiceStore((s) => s.autoGainControl);
  const rnnoiseEnabled = useVoiceStore((s) => s.rnnoiseEnabled);

  const lastMicGenRef = useRef(0);

  const updateParticipants = useCallback(() => {
    const r = roomRef.current;
    if (!r) return;
    const allParticipants: ParticipantInfo[] = [];
    const processParticipant = (p: Participant, isLocal: boolean) => {
      if (!p.identity) return;
      const { userId, username } = parseIdentity(p.identity);
      const memberMatch = useSpaceStore.getState().members.find(m => m.userId === userId);
      const homeUserId = memberMatch?.user.homeUserId ?? null;
      let audioTrack: MediaStreamTrack | null = null;
      let videoTrack: MediaStreamTrack | null = null;
      let screenTrack: MediaStreamTrack | null = null;
      let screenAudioTrack: MediaStreamTrack | null = null;
      let lkVideoTrack: Track | null = null;
      let lkScreenTrack: Track | null = null;
      let hasScreenSharePublication = false;
      p.trackPublications.forEach((pub) => {
        // Detect screen share publication even if unsubscribed
        if (pub.source === Track.Source.ScreenShare) hasScreenSharePublication = true;

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
        isPartDeafened = useVoiceStore.getState().isDeafened;
        isPartMuted = useVoiceStore.getState().isMuted;
      } else {
        isPartDeafened = userState?.isDeafened ?? useVoiceStore.getState().deafenedUserIds.has(userId);
        if (userState) isPartMuted = userState.isMuted;
      }

      allParticipants.push({
        identity: p.identity,
        userId,
        username,
        homeUserId,
        isMuted: isPartMuted,
        isDeafened: isPartDeafened,
        isCameraOn: !!videoTrack,
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

    const syncMic = async () => {
      try {
        const audioManager = AudioManager.getInstance();

        // Sync voice processing settings to AudioManager
        audioManager.setVoiceProcessing({ echoCancellation, noiseSuppression, autoGainControl });
        await audioManager.setRnnoiseEnabled(rnnoiseEnabled);

        const micPub = r.localParticipant.getTrackPublications()
          .find(p => p.source === Track.Source.Microphone);

        // If muted or deafened, mute the track in-place (keep it published)
        if (isMuted || isDeafened) {
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
  }, [isMuted, isDeafened, inputDeviceId, inputVolume, isConnected, echoCancellation, noiseSuppression, autoGainControl, rnnoiseEnabled]);

  const connect = useCallback(async (channelId: string, isDm?: boolean) => {
    const storedId = isDm ? `dm-${channelId}` : channelId;
    if (connectedChannelRef.current === storedId && roomRef.current?.state === ConnectionState.Connected) return;

    // Register voice state with the WS server after LiveKit connects (not for DM calls)
    const registerWithServer = () => {
      if (isDm) return;
      const origin = getChannelOrigin(channelId);
      wsSend({ type: 'voice_join', channelId }, origin);
      const { isMuted: m, isDeafened: d, isCameraOn: c, isScreenSharing: s } = useVoiceStore.getState();
      wsSend({ type: 'voice_status', isMuted: m, isDeafened: d, isCameraOn: c, isScreenSharing: s }, origin);
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
      const client = isDm ? getApiForOrigin('') : getApiForOrigin(getChannelOrigin(channelId));
      const { token, url } = isDm ? await client.livekit.dmToken(channelId) : await client.livekit.token(channelId);
      if (gen !== _connectGeneration) return;
      const newRoom = new Room({ adaptiveStream: true, dynacast: true, publishDefaults: { videoCodec: 'h264', simulcast: true } });
      roomRef.current = newRoom;

      const guardedUpdate = () => { if (roomRef.current === newRoom) updateParticipants(); };
      newRoom.on(RoomEvent.ParticipantConnected, (participant) => {
        guardedUpdate();
        if (useVoiceStore.getState().isDeafened) {
          const encoder = new TextEncoder();
          newRoom.localParticipant.publishData(
            encoder.encode(JSON.stringify({ type: 'deafen', deafened: true })),
            { reliable: true }
          ).catch(() => { });
        }
      });
      newRoom.on(RoomEvent.ParticipantDisconnected, guardedUpdate);
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
      newRoom.on(RoomEvent.Disconnected, () => {
        if (roomRef.current !== newRoom) return;
        SpeakingDetector.getInstance().clear();
        setConnectionState(ConnectionState.Disconnected);
        setConnectedChannelId(null);
        roomRef.current = null; _activeRoom = null; setIsConnected(false); setRoom(null);
        useVoiceStore.getState().setParticipants([]);
        useVoiceStore.getState().setSpeakingParticipants(new Set());
        useVoiceStore.getState().setIsLiveKitConnected(false);
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
    } catch (err) { if (gen === _connectGeneration) { setConnectionError('Failed to connect'); useVoiceStore.getState().setConnectionError('Failed to connect'); } }
    finally { if (gen === _connectGeneration) setIsConnecting(false); }
  }, [updateParticipants, handleDataReceived]);

  const disconnect = useCallback(async () => {
    _connectGeneration++;
    SpeakingDetector.getInstance().clear();
    connectedChannelRef.current = null;
    setConnectedChannelId(null);
    if (roomRef.current) {
      await destroyRoom(roomRef.current);
      roomRef.current = null;
      _activeRoom = null;
      setRoom(null);
      setIsConnected(false);
      setIsConnecting(false);
      setConnectionState(ConnectionState.Disconnected);
      useVoiceStore.getState().setParticipants([]);
      useVoiceStore.getState().setSpeakingParticipants(new Set());
      useVoiceStore.getState().setIsLiveKitConnected(false);
    }
  }, []);

  const toggleMic = useCallback(async () => { 
    await AudioManager.getInstance().resumeContext();
    useVoiceStore.getState().toggleMic();
  }, []);

  const toggleCamera = useCallback(async () => {
    if (roomRef.current) {
      if (!isCameraOn) {
        await roomRef.current.localParticipant.setCameraEnabled(true, { resolution: CAMERA_PRESET.resolution, frameRate: CAMERA_PRESET.encoding.maxFramerate }, { videoCodec: CAMERA_PRESET.codec, videoEncoding: CAMERA_PRESET.encoding, simulcast: true });
        setTimeout(() => { if (roomRef.current) applyOverdrive(roomRef.current, Track.Source.Camera, CAMERA_OVERDRIVE); }, 2000);
      } else { await roomRef.current.localParticipant.setCameraEnabled(false); }
      updateParticipants();
    }
  }, [isCameraOn, updateParticipants]);

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
  }, [voiceUserStates, isMuted, isDeafened, updateParticipants]);

  useEffect(() => {
    if (!room) return;
    const updateActiveTracks = async () => {
      if (isScreenSharing) {
        const opts = buildScreenShareOptions(screenShareConfig);
        const screenPub = room.localParticipant.getTrackPublications().find(p => p.source === Track.Source.ScreenShare);
        if (screenPub?.videoTrack) {
          const mediaTrack = getMediaStreamTrack(screenPub.videoTrack);
          if (mediaTrack) {
            await mediaTrack.applyConstraints({ width: { ideal: opts.capture.width }, height: { ideal: opts.capture.height }, frameRate: { ideal: opts.capture.frameRate } });
            mediaTrack.contentHint = opts.contentHint;
          }
          await applyOverdrive(room, Track.Source.ScreenShare, opts.overdrive);
        }
      }
      if (isCameraOn) { await applyOverdrive(room, Track.Source.Camera, CAMERA_OVERDRIVE); }
    };
    updateActiveTracks().catch(() => {});
  }, [room, screenShareConfig, isScreenSharing, isCameraOn]);

  useEffect(() => {
    return () => { _connectGeneration++; SpeakingDetector.getInstance().clear(); if (roomRef.current) { destroyRoom(roomRef.current); roomRef.current = null; _activeRoom = null; } };
  }, []);


  return { room, isConnected, isConnecting, connectionState, connectedChannelId, connectionError, connect, disconnect, toggleMic, toggleCamera, toggleScreenShare };
}
