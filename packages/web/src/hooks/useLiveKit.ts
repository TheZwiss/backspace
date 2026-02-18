import { useState, useCallback, useRef, useEffect } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  LocalTrackPublication,
  RemoteTrackPublication,
  Participant,
  RemoteParticipant,
  LocalParticipant,
  ConnectionState,
} from 'livekit-client';
import { api } from '../api/client';
import { useVoiceStore } from '../stores/voiceStore';

// Module-level reference so other components (e.g. VoiceControls)
// can call LiveKit SDK methods directly without prop drilling.
let _activeRoom: Room | null = null;

export function getActiveRoom(): Room | null {
  return _activeRoom;
}

export interface ParticipantInfo {
  identity: string;
  userId: string;
  username: string;
  isSpeaking: boolean;
  isMuted: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  isLocal: boolean;
  audioTrack: MediaStreamTrack | null;
  videoTrack: MediaStreamTrack | null;
  screenTrack: MediaStreamTrack | null;
}

function parseIdentity(identity: string): { userId: string; username: string } {
  const parts = identity.split(':');
  return {
    userId: parts[0] ?? identity,
    username: parts[1] ?? identity,
  };
}

// Connection lock to prevent concurrent connect() calls from racing
let _connectGeneration = 0;

export function useLiveKit() {
  const [room, setRoom] = useState<Room | null>(null);
  const [participants, setParticipants] = useState<ParticipantInfo[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const roomRef = useRef<Room | null>(null);
  const connectedChannelRef = useRef<string | null>(null);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isCameraOn = useVoiceStore((s) => s.isCameraOn);
  const isScreenSharing = useVoiceStore((s) => s.isScreenSharing);

  const updateParticipants = useCallback(() => {
    const r = roomRef.current;
    if (!r) return;

    const allParticipants: ParticipantInfo[] = [];

    const processParticipant = (p: Participant, isLocal: boolean) => {
      const { userId, username } = parseIdentity(p.identity);
      let audioTrack: MediaStreamTrack | null = null;
      let videoTrack: MediaStreamTrack | null = null;
      let screenTrack: MediaStreamTrack | null = null;

      p.trackPublications.forEach((pub) => {
        const track = pub.track;
        if (!track) return;
        if (pub.source === Track.Source.Microphone) {
          audioTrack = track.mediaStreamTrack;
        } else if (pub.source === Track.Source.Camera) {
          videoTrack = track.mediaStreamTrack;
        } else if (pub.source === Track.Source.ScreenShare) {
          screenTrack = track.mediaStreamTrack;
        }
      });

      allParticipants.push({
        identity: p.identity,
        userId,
        username,
        isSpeaking: p.isSpeaking,
        isMuted: !p.isMicrophoneEnabled,
        isCameraOn: p.isCameraEnabled,
        isScreenSharing: p.isScreenShareEnabled,
        isLocal,
        audioTrack,
        videoTrack,
        screenTrack,
      });
    };

    processParticipant(r.localParticipant, true);
    r.remoteParticipants.forEach((p) => processParticipant(p, false));

    setParticipants(allParticipants);
  }, []);

  const connect = useCallback(async (channelId: string) => {
    // Don't reconnect if already connected to this channel
    if (connectedChannelRef.current === channelId && roomRef.current) {
      console.log('[LiveKit] Already connected to channel:', channelId);
      return;
    }

    // Bump generation — any in-flight connect with an older generation
    // will bail out after its async gaps.
    const gen = ++_connectGeneration;
    console.log('[LiveKit] connect() gen=%d channel=%s', gen, channelId);

    // Tear down any existing room synchronously
    if (roomRef.current) {
      try { roomRef.current.disconnect(); } catch {}
      roomRef.current = null;
      _activeRoom = null;
      connectedChannelRef.current = null;
    }

    setIsConnecting(true);
    setConnectionError(null);
    useVoiceStore.getState().setConnectionError(null);
    useVoiceStore.getState().setIsLiveKitConnected(false);

    try {
      console.log('[LiveKit] Fetching token for channel:', channelId);
      const { token, url } = await api.livekit.token(channelId);

      // Abort if a newer connect() was called while we were fetching the token
      if (gen !== _connectGeneration) {
        console.log('[LiveKit] gen=%d aborted (superseded by gen=%d)', gen, _connectGeneration);
        return;
      }

      console.log('[LiveKit] Got token, connecting to:', url);
      const newRoom = new Room({
        adaptiveStream: true,
        dynacast: true,
      });

      // Guard all event handlers: only update state if this room is still current.
      // Without this, stale events from old rooms corrupt the new room's state.
      const guardedUpdate = () => {
        if (roomRef.current === newRoom) updateParticipants();
      };
      newRoom.on(RoomEvent.ParticipantConnected, guardedUpdate);
      newRoom.on(RoomEvent.ParticipantDisconnected, guardedUpdate);
      newRoom.on(RoomEvent.TrackSubscribed, guardedUpdate);
      newRoom.on(RoomEvent.TrackUnsubscribed, guardedUpdate);
      newRoom.on(RoomEvent.TrackMuted, guardedUpdate);
      newRoom.on(RoomEvent.TrackUnmuted, guardedUpdate);
      newRoom.on(RoomEvent.ActiveSpeakersChanged, guardedUpdate);
      newRoom.on(RoomEvent.ConnectionStateChanged, (state) => {
        console.log('[LiveKit] ConnectionStateChanged:', state, 'isCurrentRoom:', roomRef.current === newRoom);
        // Only update state if this room is still the active one
        if (roomRef.current === newRoom) {
          setIsConnected(state === ConnectionState.Connected);
        }
      });
      newRoom.on(RoomEvent.Disconnected, () => {
        console.log('[LiveKit] Disconnected event fired, isCurrentRoom:', roomRef.current === newRoom);
        // CRITICAL: Only clear state if this room is still the active one.
        // If a newer connect() has already replaced us, don't nuke its state.
        if (roomRef.current !== newRoom) {
          console.log('[LiveKit] Ignoring stale Disconnected event from old room');
          return;
        }
        roomRef.current = null;
        _activeRoom = null;
        connectedChannelRef.current = null;
        setIsConnected(false);
        setRoom(null);
        setParticipants([]);
        useVoiceStore.getState().setIsLiveKitConnected(false);
        useVoiceStore.getState().setConnectionError('Disconnected from voice');
      });

      await newRoom.connect(url, token);

      // Abort if a newer connect() was called while we were connecting
      if (gen !== _connectGeneration) {
        console.log('[LiveKit] gen=%d aborted after connect (superseded)', gen);
        newRoom.disconnect();
        return;
      }

      console.log('[LiveKit] Connected successfully! gen=%d', gen);
      roomRef.current = newRoom;
      _activeRoom = newRoom;
      connectedChannelRef.current = channelId;
      setRoom(newRoom);
      setIsConnected(true);
      useVoiceStore.getState().setIsLiveKitConnected(true);
      useVoiceStore.getState().setConnectionError(null);
      updateParticipants();

      // Enable mic only (not camera) by default.
      // Reset media state in store to match SDK state — prevents desync after reconnects.
      useVoiceStore.setState({ isMuted: false, isCameraOn: false, isScreenSharing: false });
      try {
        await newRoom.localParticipant.setMicrophoneEnabled(true);
        console.log('[LiveKit] Microphone enabled');
        updateParticipants();
      } catch (mediaErr) {
        console.warn('[LiveKit] Could not enable microphone:', mediaErr);
        // Mic failed to enable — mark as muted in store
        useVoiceStore.setState({ isMuted: true });
      }
    } catch (err) {
      // Only set error if this is still the active generation
      if (gen === _connectGeneration) {
        const message = err instanceof Error ? err.message : 'Failed to connect to voice';
        console.error('[LiveKit] Connection failed:', err);
        connectedChannelRef.current = null;
        setConnectionError(message);
        useVoiceStore.getState().setConnectionError(message);
      }
    } finally {
      if (gen === _connectGeneration) {
        setIsConnecting(false);
      }
    }
  }, [updateParticipants]);

  const disconnect = useCallback(async () => {
    // Bump generation so any in-flight connect aborts
    _connectGeneration++;
    if (roomRef.current) {
      await roomRef.current.disconnect();
      roomRef.current = null;
      _activeRoom = null;
      connectedChannelRef.current = null;
      setRoom(null);
      setIsConnected(false);
      setParticipants([]);
      useVoiceStore.getState().setIsLiveKitConnected(false);
    }
  }, []);

  const toggleMic = useCallback(async () => {
    if (roomRef.current) {
      await roomRef.current.localParticipant.setMicrophoneEnabled(isMuted);
      updateParticipants();
    }
  }, [isMuted, updateParticipants]);

  const toggleCamera = useCallback(async () => {
    if (roomRef.current) {
      await roomRef.current.localParticipant.setCameraEnabled(!isCameraOn);
      updateParticipants();
    }
  }, [isCameraOn, updateParticipants]);

  const toggleScreenShare = useCallback(async () => {
    if (roomRef.current) {
      await roomRef.current.localParticipant.setScreenShareEnabled(!isScreenSharing);
      updateParticipants();
    }
  }, [isScreenSharing, updateParticipants]);

  useEffect(() => {
    return () => {
      _connectGeneration++;
      if (roomRef.current) {
        roomRef.current.disconnect();
        roomRef.current = null;
        _activeRoom = null;
        connectedChannelRef.current = null;
      }
    };
  }, []);

  return {
    room,
    participants,
    isConnected,
    isConnecting,
    connectionError,
    connect,
    disconnect,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
  };
}
