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
  VideoPresets,
  VideoPreset,
  LocalAudioTrack,
  LocalTrackPublication,
} from 'livekit-client';
import { api } from '../api/client';
import { useVoiceStore } from '../stores/voiceStore';
import { AudioManager } from '../audio/AudioManager';

/**
 * OPENCORD NATIVE OVERDRIVE PIPELINE v32
 */

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

const QUALITY_MAP: Record<string, VideoPreset> = {
  '1080p60': new VideoPreset(1920, 1080, 12_000_000, 60),
  '1080p': new VideoPreset(1920, 1080, 8_000_000, 30),
  '720p60': new VideoPreset(1280, 720, 8_000_000, 60),
  '720p': new VideoPreset(1280, 720, 4_000_000, 30),
  '540p': new VideoPreset(960, 540, 2_000_000, 30),
  '360p': new VideoPreset(640, 360, 1_000_000, 30),
};

const AUTO_PRESET = QUALITY_MAP['720p60']!;

let _activeRoom: Room | null = null;

export function getActiveRoom(): Room | null {
  return _activeRoom;
}

export interface ParticipantInfo {
  identity: string;
  userId: string;
  username: string;
  isMuted: boolean;
  isDeafened: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  isLocal: boolean;
  audioTrack: MediaStreamTrack | null;
  videoTrack: MediaStreamTrack | null;
  screenTrack: MediaStreamTrack | null;
  screenAudioTrack: MediaStreamTrack | null;
}

export interface UserTile {
  kind: 'user';
  key: string;                        // participant.identity
  participant: ParticipantInfo;
  videoTrack: MediaStreamTrack | null; // camera only
  audioTrack: MediaStreamTrack | null; // mic
}

export interface StreamTile {
  kind: 'stream';
  key: string;                        // `${identity}:stream`
  participant: ParticipantInfo;
  screenTrack: MediaStreamTrack | null;
  screenAudioTrack: MediaStreamTrack | null;
}

export type GridTile = UserTile | StreamTile;

export function deriveGridTiles(participants: ParticipantInfo[]): GridTile[] {
  const tiles: GridTile[] = [];
  for (const p of participants) {
    tiles.push({
      kind: 'user',
      key: p.identity,
      participant: p,
      videoTrack: (p.isCameraOn && p.videoTrack?.readyState === 'live') ? p.videoTrack : null,
      audioTrack: p.audioTrack,
    });
    if (p.isScreenSharing) {
      tiles.push({
        kind: 'stream',
        key: `${p.identity}:stream`,
        participant: p,
        screenTrack: p.screenTrack,
        screenAudioTrack: p.screenAudioTrack,
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

async function applyOverdriveHammer(room: Room, source: Track.Source, preset: VideoPreset) {
  try {
    const pub = room.localParticipant.getTrackPublications().find(p => p.source === source);
    if (!pub?.track) return;

    const engine = (room as any).engine;
    const pc = engine?.pcManager?.publisher?.pc || engine?.publisher?.pc || engine?.pc;
    if (pc) {
      const senders = (pc as RTCPeerConnection).getSenders();
      const sender = senders.find(s => s.track?.id === (pub.track as any).mediaStreamTrack?.id);
      if (sender) {
        const params = sender.getParameters();
        if (params.encodings && params.encodings[0]) {
          params.encodings[0].maxBitrate = preset.encoding.maxBitrate;
          (params.encodings[0] as any).minBitrate = 2_000_000;
          params.encodings[0].maxFramerate = preset.encoding.maxFramerate;
          params.encodings[0].networkPriority = 'high';
          // @ts-ignore
          params.degradationPreference = 'maintain-framerate';
          await sender.setParameters(params);
        }
      }
    }
  } catch (err) {}
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
  const videoQuality = useVoiceStore((s) => s.videoQuality);
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
      let audioTrack: MediaStreamTrack | null = null;
      let videoTrack: MediaStreamTrack | null = null;
      let screenTrack: MediaStreamTrack | null = null;
      let screenAudioTrack: MediaStreamTrack | null = null;
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
        else if (pub.source === Track.Source.Camera && p.isCameraEnabled) videoTrack = mt;
        else if (pub.source === Track.Source.ScreenShare) screenTrack = mt;
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
        isMuted: isPartMuted,
        isDeafened: isPartDeafened,
        isCameraOn: !!videoTrack,
        isScreenSharing: hasScreenSharePublication, // True even when unsubscribed
        isLocal,
        audioTrack,
        videoTrack,
        screenTrack,
        screenAudioTrack,
      });
    };
    processParticipant(r.localParticipant, true);
    r.remoteParticipants.forEach((p) => processParticipant(p, false));
    useVoiceStore.getState().setParticipants(allParticipants);
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
        // Keep screen share state in sync (handles edge cases like remounts)
        audioManager.setScreenShareActive(isScreenSharing);

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
  }, [isMuted, isDeafened, inputDeviceId, inputVolume, isConnected, echoCancellation, noiseSuppression, autoGainControl, rnnoiseEnabled, isScreenSharing]);

  const connect = useCallback(async (channelId: string) => {
    if (connectedChannelRef.current === channelId && roomRef.current?.state === ConnectionState.Connected) return;
    const gen = ++_connectGeneration;

    // Ensure AudioContext is created and resumed before tracks arrive
    await AudioManager.getInstance().resumeContext();

    // 1. Reset state immediately to reflect "Loading/Switching" in UI
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
        console.log('[LiveKit] Disconnecting previous room:', roomToDisconnect.name);
        await roomToDisconnect.disconnect();
      } catch (err) {
        console.warn('Error disconnecting from previous room:', err);
      }
      roomRef.current = null;
      _activeRoom = null;
    }
    
    try {
      const { token, url } = await api.livekit.token(channelId);
      if (gen !== _connectGeneration) return;
      const newRoom = new Room({ adaptiveStream: false, dynacast: false, publishDefaults: { videoCodec: 'h264', simulcast: false } });
      roomRef.current = newRoom;
      
      const guardedUpdate = () => { if (roomRef.current === newRoom) updateParticipants(); };
      // ... existing event listeners ...
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
        }
        guardedUpdate();
      });
      newRoom.on(RoomEvent.TrackMuted, guardedUpdate);
      newRoom.on(RoomEvent.TrackUnmuted, guardedUpdate);
      newRoom.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        if (roomRef.current !== newRoom) return;
        useVoiceStore.getState().setSpeakingParticipants(
          new Set(speakers.map(s => s.identity))
        );
      });
      newRoom.on(RoomEvent.ParticipantMetadataChanged, guardedUpdate);
      newRoom.on(RoomEvent.TrackPublished, (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (
          publication.source === Track.Source.ScreenShare ||
          publication.source === Track.Source.ScreenShareAudio
        ) {
          (publication as RemoteTrackPublication).setSubscribed(false);
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
            updateParticipants();
          }
        }
      });
      newRoom.on(RoomEvent.Disconnected, () => {
        if (roomRef.current !== newRoom) return;
        setConnectionState(ConnectionState.Disconnected);
        setConnectedChannelId(null);
        roomRef.current = null; _activeRoom = null; setIsConnected(false); setRoom(null);
        useVoiceStore.getState().setParticipants([]);
        useVoiceStore.getState().setSpeakingParticipants(new Set());
        useVoiceStore.getState().setIsLiveKitConnected(false);
      });

      await newRoom.connect(url, token);
      if (gen !== _connectGeneration) { newRoom.disconnect(); return; }
      _activeRoom = newRoom; 
      connectedChannelRef.current = channelId; 
      setConnectedChannelId(channelId);
      setRoom(newRoom); 
      setIsConnected(true);
      useVoiceStore.getState().setIsLiveKitConnected(true);
      
      updateParticipants();

      // Unsubscribe from any remote screen share tracks that auto-subscribed during connect
      newRoom.remoteParticipants.forEach((rp) => {
        rp.trackPublications.forEach((pub) => {
          if (
            (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) &&
            pub.isSubscribed
          ) {
            (pub as RemoteTrackPublication).setSubscribed(false);
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

  const connectDm = useCallback(async (dmChannelId: string) => {
    const gen = ++_connectGeneration;

    // Ensure AudioContext is created and resumed before tracks arrive
    await AudioManager.getInstance().resumeContext();

    // 1. Reset state immediately
    setRoom(null);
    useVoiceStore.getState().setParticipants([]);
    useVoiceStore.getState().setSpeakingParticipants(new Set());
    setIsConnected(false);
    setIsConnecting(true);
    setConnectionState(ConnectionState.Connecting);
    setConnectionError(null);
    setConnectedChannelId(null);

    useVoiceStore.getState().setConnectionError(null);
    useVoiceStore.getState().setConnectionQuality('unknown');

    // 2. Strictly disconnect previous room (Local Ref OR Global Ref)
    const roomToDisconnect = roomRef.current || _activeRoom;

    if (roomToDisconnect) {
      try {
        console.log('[LiveKit] Disconnecting previous room (DM):', roomToDisconnect.name);
        await roomToDisconnect.disconnect();
      } catch (err) {
        console.warn('Error disconnecting from previous room:', err);
      }
      roomRef.current = null;
      _activeRoom = null;
    }

    try {
      const { token, url } = await api.livekit.dmToken(dmChannelId);
      if (gen !== _connectGeneration) return;
      const newRoom = new Room({ adaptiveStream: false, dynacast: false, publishDefaults: { videoCodec: 'h264', simulcast: false } });
      roomRef.current = newRoom;
      const guardedUpdate = () => { if (roomRef.current === newRoom) updateParticipants(); };
      newRoom.on(RoomEvent.ParticipantConnected, guardedUpdate);
      newRoom.on(RoomEvent.ParticipantDisconnected, guardedUpdate);
      newRoom.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
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
        }
        guardedUpdate();
      });
      newRoom.on(RoomEvent.TrackMuted, guardedUpdate);
      newRoom.on(RoomEvent.TrackUnmuted, guardedUpdate);
      newRoom.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        if (roomRef.current !== newRoom) return;
        useVoiceStore.getState().setSpeakingParticipants(
          new Set(speakers.map(s => s.identity))
        );
      });
      newRoom.on(RoomEvent.TrackPublished, (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (
          publication.source === Track.Source.ScreenShare ||
          publication.source === Track.Source.ScreenShareAudio
        ) {
          (publication as RemoteTrackPublication).setSubscribed(false);
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
            updateParticipants();
          }
        }
      });
      await newRoom.connect(url, token);
      if (gen !== _connectGeneration) { newRoom.disconnect(); return; }
      const fullId = `dm-${dmChannelId}`;
      _activeRoom = newRoom;
      connectedChannelRef.current = fullId;
      setConnectedChannelId(fullId);
      setRoom(newRoom);
      setIsConnected(true);
      useVoiceStore.getState().setIsLiveKitConnected(true);
      updateParticipants();

      // Unsubscribe from any remote screen share tracks that auto-subscribed during connect
      newRoom.remoteParticipants.forEach((rp) => {
        rp.trackPublications.forEach((pub) => {
          if (
            (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) &&
            pub.isSubscribed
          ) {
            (pub as RemoteTrackPublication).setSubscribed(false);
          }
        });
      });

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
    connectedChannelRef.current = null;
    setConnectedChannelId(null);
    if (roomRef.current) { 
      await roomRef.current.disconnect(); 
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
        const preset = QUALITY_MAP[videoQuality] || VideoPresets.h720;
        await roomRef.current.localParticipant.setCameraEnabled(true, { resolution: preset.resolution, frameRate: preset.encoding.maxFramerate }, { videoCodec: 'h264', videoEncoding: preset.encoding, simulcast: false });
        setTimeout(() => { if (roomRef.current) applyOverdriveHammer(roomRef.current, Track.Source.Camera, preset); }, 2000);
      } else { await roomRef.current.localParticipant.setCameraEnabled(false); }
      updateParticipants();
    }
  }, [isCameraOn, videoQuality, updateParticipants]);

  const toggleScreenShare = useCallback(async () => {
    if (roomRef.current) {
      if (!isScreenSharing) {
        // Notify AudioManager BEFORE enabling screen share so the mic track
        // gets republished with AEC off, preventing Chrome's ducking.
        AudioManager.getInstance().setScreenShareActive(true);

        const preset = QUALITY_MAP[videoQuality] || AUTO_PRESET;
        const track = await roomRef.current.localParticipant.setScreenShareEnabled(true, {
          audio: true,
          resolution: VideoPresets.h360.resolution,
          // @ts-ignore
          frameRate: 30,
        }, {
          videoCodec: 'h264', videoEncoding: VideoPresets.h360.encoding, simulcast: false, priority: 'very-high'
        } as any);

        if (track) {
          setTimeout(async () => {
            if (roomRef.current && isScreenSharing) {
              const screenPub = roomRef.current.localParticipant.getTrackPublications().find(p => p.source === Track.Source.ScreenShare);
              if (screenPub?.track?.mediaStreamTrack) {
                 await screenPub.track.mediaStreamTrack.applyConstraints({
                   width: { ideal: preset.resolution.width },
                   height: { ideal: preset.resolution.height },
                   frameRate: { ideal: preset.encoding.maxFramerate, min: 30 }
                 });
                 await applyOverdriveHammer(roomRef.current, Track.Source.ScreenShare, preset);
              }
            }
          }, 2000);
          setTimeout(() => applyOverdriveHammer(roomRef.current!, Track.Source.ScreenShare, preset), 5000);
        }
      } else {
        await roomRef.current.localParticipant.setScreenShareEnabled(false);
        // Restore user's AEC preference after screen share ends
        AudioManager.getInstance().setScreenShareActive(false);
      }
      updateParticipants();
    }
  }, [isScreenSharing, videoQuality, updateParticipants]);

  useEffect(() => {
    updateParticipants();
  }, [voiceUserStates, isMuted, isDeafened, updateParticipants]);

  useEffect(() => {
    if (!room) return;
    const preset = QUALITY_MAP[videoQuality] || AUTO_PRESET;
    const updateActiveTracks = async () => {
      if (isScreenSharing) {
        const screenPub = room.localParticipant.getTrackPublications().find(p => p.source === Track.Source.ScreenShare);
        if (screenPub?.videoTrack) {
          const mediaTrack = (screenPub.videoTrack as any).mediaStreamTrack as MediaStreamTrack;
          if (mediaTrack) {
            await mediaTrack.applyConstraints({ width: { ideal: preset.resolution.width }, height: { ideal: preset.resolution.height }, frameRate: { ideal: preset.encoding.maxFramerate } });
          }
          await applyOverdriveHammer(room, Track.Source.ScreenShare, preset);
        }
      }
      if (isCameraOn) { await applyOverdriveHammer(room, Track.Source.Camera, preset); }
    };
    updateActiveTracks().catch(() => {});
  }, [room, videoQuality, isScreenSharing, isCameraOn]);

  useEffect(() => {
    if (!room) return;
    const interval = setInterval(async () => {
      try {
        const engine = (room as any).engine;
        const pc = engine?.pcManager?.publisher?.pc || engine?.publisher?.pc || engine?.pc || (room as any).pc;
        if (!pc) return;
        const stats = await (pc as RTCPeerConnection).getStats();
        stats.forEach((report: any) => {
          if (report.type === 'outbound-rtp' && report.kind === 'video' && report.frameWidth > 0) {
            const fps = Math.round(report.framesPerSecond || 0);
            const key = `_lastBytes_${report.ssrc}`;
            const lastBytes = (window as any)[key] || report.bytesSent;
            const bitrate = (((report.bytesSent - lastBytes) * 8) / 5000 / 1000).toFixed(2);
            (window as any)[key] = report.bytesSent;
            console.log(`[Soft-Launch Diagnostic] ${report.frameWidth}x${report.frameHeight} @ ${fps} FPS (~${bitrate} Mbps) | ${report.qualityLimitationReason}`);
          }
        });
      } catch (err) { }
    }, 5000);
    return () => clearInterval(interval);
  }, [room]);

  useEffect(() => {
    return () => { _connectGeneration++; if (roomRef.current) { roomRef.current.disconnect(); roomRef.current = null; _activeRoom = null; } };
  }, []);

  // Speaking poll safety net: catches missed ActiveSpeakersChanged events
  useEffect(() => {
    if (!isConnected) return;
    const interval = setInterval(() => {
      const r = roomRef.current;
      if (!r) return;
      const speakingIds = new Set<string>();
      if (r.localParticipant.isSpeaking) speakingIds.add(r.localParticipant.identity);
      r.remoteParticipants.forEach((p) => {
        if (p.isSpeaking) speakingIds.add(p.identity);
      });
      const current = useVoiceStore.getState().speakingParticipantIds;
      if (!setsEqual(current, speakingIds)) {
        useVoiceStore.getState().setSpeakingParticipants(speakingIds);
      }
    }, 200);
    return () => clearInterval(interval);
  }, [isConnected]);

  return { room, isConnected, isConnecting, connectionState, connectedChannelId, connectionError, connect, connectDm, disconnect, toggleMic, toggleCamera, toggleScreenShare };
}
