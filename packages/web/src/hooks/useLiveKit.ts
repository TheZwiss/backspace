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

export interface ParticipantInfo {
  identity: string;
  userId: string;
  username: string;
  isSpeaking: boolean;
  isMuted: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
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

export function useLiveKit() {
  const [room, setRoom] = useState<Room | null>(null);
  const [participants, setParticipants] = useState<ParticipantInfo[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isCameraOn = useVoiceStore((s) => s.isCameraOn);
  const isScreenSharing = useVoiceStore((s) => s.isScreenSharing);

  const updateParticipants = useCallback(() => {
    const r = roomRef.current;
    if (!r) return;

    const allParticipants: ParticipantInfo[] = [];

    const processParticipant = (p: Participant) => {
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
        audioTrack,
        videoTrack,
        screenTrack,
      });
    };

    processParticipant(r.localParticipant);
    r.remoteParticipants.forEach(processParticipant);

    setParticipants(allParticipants);
  }, []);

  const connect = useCallback(async (channelId: string) => {
    if (roomRef.current) {
      await roomRef.current.disconnect();
    }

    setIsConnecting(true);
    try {
      const { token } = await api.livekit.token(channelId);
      const livekitUrl = 'wss://nova.ddns.net/livekit';

      const newRoom = new Room({
        adaptiveStream: true,
        dynacast: true,
      });

      newRoom.on(RoomEvent.ParticipantConnected, updateParticipants);
      newRoom.on(RoomEvent.ParticipantDisconnected, updateParticipants);
      newRoom.on(RoomEvent.TrackSubscribed, updateParticipants);
      newRoom.on(RoomEvent.TrackUnsubscribed, updateParticipants);
      newRoom.on(RoomEvent.TrackMuted, updateParticipants);
      newRoom.on(RoomEvent.TrackUnmuted, updateParticipants);
      newRoom.on(RoomEvent.ActiveSpeakersChanged, updateParticipants);
      newRoom.on(RoomEvent.ConnectionStateChanged, (state) => {
        setIsConnected(state === ConnectionState.Connected);
      });
      newRoom.on(RoomEvent.Disconnected, () => {
        setIsConnected(false);
        setParticipants([]);
      });

      await newRoom.connect(livekitUrl, token);
      await newRoom.localParticipant.enableCameraAndMicrophone();

      roomRef.current = newRoom;
      setRoom(newRoom);
      setIsConnected(true);
      updateParticipants();
    } catch (err) {
      console.error('Failed to connect to LiveKit:', err);
    } finally {
      setIsConnecting(false);
    }
  }, [updateParticipants]);

  const disconnect = useCallback(async () => {
    if (roomRef.current) {
      await roomRef.current.disconnect();
      roomRef.current = null;
      setRoom(null);
      setIsConnected(false);
      setParticipants([]);
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
      if (roomRef.current) {
        roomRef.current.disconnect();
      }
    };
  }, []);

  return {
    room,
    participants,
    isConnected,
    isConnecting,
    connect,
    disconnect,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
  };
}
