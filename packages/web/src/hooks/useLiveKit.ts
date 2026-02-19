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
  VideoPresets,
  VideoEncoding,
  VideoPreset,
} from 'livekit-client';
import { api } from '../api/client';
import { useVoiceStore } from '../stores/voiceStore';

/**
 * OPENCORD NATIVE OVERDRIVE PIPELINE v22
 * "Soft-Launch Protocol": Always starts low to clear handshake, then upgrades to target.
 */

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
  isSpeaking: boolean;
  isMuted: boolean;
  isDeafened: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  isLocal: boolean;
  audioTrack: MediaStreamTrack | null;
  videoTrack: MediaStreamTrack | null;
  screenTrack: MediaStreamTrack | null;
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
      const sender = senders.find(s => s.track?.id === pub.track?.mediaStreamTrack?.id);
      if (sender) {
        const params = sender.getParameters();
        if (params.encodings && params.encodings[0]) {
          console.log(`[Overdrive] Upgrading ${source} to ${preset.encoding.maxBitrate}bps`);
          params.encodings[0].maxBitrate = preset.encoding.maxBitrate;
          // Gentle floor to keep stable
          (params.encodings[0] as any).minBitrate = 2_000_000;
          params.encodings[0].maxFramerate = preset.encoding.maxFramerate;
          params.encodings[0].networkPriority = 'high';
          // @ts-ignore
          params.degradationPreference = 'maintain-framerate';
          await sender.setParameters(params);
        }
      }
    }
    if ((pub.track as any).mediaStreamTrack) {
      (pub.track as any).mediaStreamTrack.contentHint = 'motion';
    }
  } catch (err) {}
}

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
  const videoQuality = useVoiceStore((s) => s.videoQuality);

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
        const mt = track.mediaStreamTrack;
        if (!mt || mt.readyState !== 'live') return;
        if (pub.source === Track.Source.Microphone) audioTrack = mt;
        else if (pub.source === Track.Source.Camera && p.isCameraEnabled) videoTrack = mt;
        else if (pub.source === Track.Source.ScreenShare && p.isScreenShareEnabled) screenTrack = mt;
      });
      let isDeafened = false;
      if (isLocal) {
        isDeafened = useVoiceStore.getState().isDeafened;
      } else {
        isDeafened = useVoiceStore.getState().deafenedUserIds.has(userId);
      }
      allParticipants.push({ identity: p.identity, userId, username, isSpeaking: p.isSpeaking, isMuted: !p.isMicrophoneEnabled, isDeafened, isCameraOn: p.isCameraEnabled, isScreenSharing: p.isScreenShareEnabled, isLocal, audioTrack, videoTrack, screenTrack });
    };
    processParticipant(r.localParticipant, true);
    r.remoteParticipants.forEach((p) => processParticipant(p, false));
    setParticipants(allParticipants);
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
    } catch {}
  }, [updateParticipants]);

  const connect = useCallback(async (channelId: string) => {
    if (connectedChannelRef.current === channelId && roomRef.current) return;
    const gen = ++_connectGeneration;
    if (roomRef.current) { try { roomRef.current.disconnect(); } catch {} roomRef.current = null; }
    setIsConnecting(true);
    useVoiceStore.getState().setIsLiveKitConnected(false);
    try {
      const { token, url } = await api.livekit.token(channelId);
      if (gen !== _connectGeneration) return;
      // Disable simulcast for better 60fps stability on local networks
      const newRoom = new Room({ adaptiveStream: false, dynacast: false, publishDefaults: { videoCodec: 'h264', simulcast: false } });
      roomRef.current = newRoom;
      const guardedUpdate = () => { if (roomRef.current === newRoom) updateParticipants(); };
      newRoom.on(RoomEvent.ParticipantConnected, (participant) => {
        guardedUpdate();
        // Re-broadcast local deafen state to newly connected participant
        if (useVoiceStore.getState().isDeafened) {
          const encoder = new TextEncoder();
          newRoom.localParticipant.publishData(
            encoder.encode(JSON.stringify({ type: 'deafen', deafened: true })),
            { reliable: true }
          ).catch(() => {});
        }
      });
      newRoom.on(RoomEvent.ParticipantDisconnected, guardedUpdate);
      newRoom.on(RoomEvent.TrackSubscribed, guardedUpdate);
      newRoom.on(RoomEvent.TrackUnsubscribed, guardedUpdate);
      newRoom.on(RoomEvent.LocalTrackPublished, guardedUpdate);
      newRoom.on(RoomEvent.LocalTrackUnpublished, guardedUpdate);
      newRoom.on(RoomEvent.TrackMuted, guardedUpdate);
      newRoom.on(RoomEvent.TrackUnmuted, guardedUpdate);
      newRoom.on(RoomEvent.ActiveSpeakersChanged, guardedUpdate);
      newRoom.on(RoomEvent.ParticipantMetadataChanged, guardedUpdate);
      newRoom.on(RoomEvent.DataReceived, handleDataReceived);
      newRoom.on(RoomEvent.ConnectionStateChanged, (state) => {
        if (roomRef.current === newRoom) {
          const connected = state === ConnectionState.Connected;
          setIsConnected(connected);
          useVoiceStore.getState().setIsLiveKitConnected(connected);
        }
      });
      newRoom.on(RoomEvent.Disconnected, () => {
        if (roomRef.current !== newRoom) return;
        roomRef.current = null; _activeRoom = null; setIsConnected(false); setRoom(null); setParticipants([]);
        useVoiceStore.getState().setIsLiveKitConnected(false);
      });
      await newRoom.connect(url, token);
      if (gen !== _connectGeneration) { newRoom.disconnect(); return; }
      _activeRoom = newRoom; connectedChannelRef.current = channelId; setRoom(newRoom); setIsConnected(true);
      useVoiceStore.getState().setIsLiveKitConnected(true);
      updateParticipants();
      // Preserve mute/deafen state across channel switches, only reset camera/screen
      const { isMuted: wasMuted, isDeafened: wasDeafened } = useVoiceStore.getState();
      useVoiceStore.setState({ isCameraOn: false, isScreenSharing: false });
      if (!wasMuted && !wasDeafened) {
        try { await newRoom.localParticipant.setMicrophoneEnabled(true); updateParticipants(); } catch { useVoiceStore.setState({ isMuted: true }); }
      } else {
        // Keep mic disabled — user was muted or deafened
        if (wasDeafened) {
          newRoom.remoteParticipants.forEach((p) => p.setVolume(0));
        }
        updateParticipants();
      }
    } catch (err) { if (gen === _connectGeneration) setConnectionError('Failed to connect'); }
    finally { if (gen === _connectGeneration) setIsConnecting(false); }
  }, [updateParticipants, handleDataReceived]);

  const connectDm = useCallback(async (dmChannelId: string) => {
    const gen = ++_connectGeneration;
    if (roomRef.current) { try { roomRef.current.disconnect(); } catch {} roomRef.current = null; }
    setIsConnecting(true);
    try {
      const { token, url } = await api.livekit.dmToken(dmChannelId);
      if (gen !== _connectGeneration) return;
      const newRoom = new Room({ adaptiveStream: false, dynacast: false, publishDefaults: { videoCodec: 'h264', simulcast: false } });
      roomRef.current = newRoom;
      const guardedUpdate = () => { if (roomRef.current === newRoom) updateParticipants(); };
      newRoom.on(RoomEvent.ParticipantConnected, guardedUpdate);
      newRoom.on(RoomEvent.ParticipantDisconnected, guardedUpdate);
      newRoom.on(RoomEvent.TrackSubscribed, guardedUpdate);
      newRoom.on(RoomEvent.TrackUnsubscribed, guardedUpdate);
      newRoom.on(RoomEvent.LocalTrackPublished, guardedUpdate);
      newRoom.on(RoomEvent.LocalTrackUnpublished, guardedUpdate);
      newRoom.on(RoomEvent.TrackMuted, guardedUpdate);
      newRoom.on(RoomEvent.TrackUnmuted, guardedUpdate);
      newRoom.on(RoomEvent.ActiveSpeakersChanged, guardedUpdate);
      newRoom.on(RoomEvent.ConnectionStateChanged, (state) => {
        if (roomRef.current === newRoom) {
          const connected = state === ConnectionState.Connected;
          setIsConnected(connected);
          useVoiceStore.getState().setIsLiveKitConnected(connected);
        }
      });
      await newRoom.connect(url, token);
      if (gen !== _connectGeneration) { newRoom.disconnect(); return; }
      _activeRoom = newRoom; connectedChannelRef.current = `dm-${dmChannelId}`; setRoom(newRoom); setIsConnected(true);
      useVoiceStore.getState().setIsLiveKitConnected(true);
      updateParticipants();
      const { isMuted: wasMuted, isDeafened: wasDeafened } = useVoiceStore.getState();
      useVoiceStore.setState({ isCameraOn: false, isScreenSharing: false });
      if (!wasMuted && !wasDeafened) {
        try { await newRoom.localParticipant.setMicrophoneEnabled(true); updateParticipants(); } catch { useVoiceStore.setState({ isMuted: true }); }
      } else {
        if (wasDeafened) {
          newRoom.remoteParticipants.forEach((p) => p.setVolume(0));
        }
        updateParticipants();
      }
    } catch (err) { if (gen === _connectGeneration) setConnectionError('Failed to connect'); }
    finally { if (gen === _connectGeneration) setIsConnecting(false); }
  }, [updateParticipants, handleDataReceived]);

  const disconnect = useCallback(async () => {
    _connectGeneration++;
    if (roomRef.current) { await roomRef.current.disconnect(); roomRef.current = null; _activeRoom = null; connectedChannelRef.current = null; setRoom(null); setIsConnected(false); setParticipants([]); useVoiceStore.getState().setIsLiveKitConnected(false); }
  }, []);

  const toggleMic = useCallback(async () => { if (roomRef.current) { await roomRef.current.localParticipant.setMicrophoneEnabled(isMuted); updateParticipants(); } }, [isMuted, updateParticipants]);

  const toggleCamera = useCallback(async () => {
    if (roomRef.current) {
      if (!isCameraOn) {
        const preset = QUALITY_MAP[videoQuality] || VideoPresets.h720;
        await roomRef.current.localParticipant.setCameraEnabled(true, { resolution: preset.resolution, frameRate: preset.encoding.maxFramerate }, { videoCodec: 'h264', videoEncoding: preset.encoding, simulcast: false });
        // Soft Start Camera
        setTimeout(() => { if (roomRef.current) applyOverdriveHammer(roomRef.current, Track.Source.Camera, preset); }, 2000);
      } else { await roomRef.current.localParticipant.setCameraEnabled(false); }
      updateParticipants();
    }
  }, [isCameraOn, videoQuality, updateParticipants]);

  const toggleScreenShare = useCallback(async () => {
    if (roomRef.current) {
      if (!isScreenSharing) {
        const preset = QUALITY_MAP[videoQuality] || AUTO_PRESET;
        console.log('[LiveKit] Soft-Launching Screen Share (360p start)...');

        // SOFT LAUNCH: Start at 360p 30fps to clear handshake
        const track = await roomRef.current.localParticipant.setScreenShareEnabled(true, {
          resolution: VideoPresets.h360.resolution,
          // @ts-ignore
          frameRate: 30,
        }, {
          videoCodec: 'h264', videoEncoding: VideoPresets.h360.encoding, simulcast: false, priority: 'very-high'
        } as any);

        if (track) {
          // UPGRADE: After 2 seconds, switch to full 60fps quality
          setTimeout(async () => {
            if (roomRef.current && isScreenSharing) {
              console.log('[LiveKit] Upgrading to Target Quality...');
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

          // Re-apply hammer
          setTimeout(() => applyOverdriveHammer(roomRef.current!, Track.Source.ScreenShare, preset), 5000);
        }
      } else { await roomRef.current.localParticipant.setScreenShareEnabled(false); }
      updateParticipants();
    }
  }, [isScreenSharing, videoQuality, updateParticipants]);

  // Sync quality changes
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
      } catch (err) {}
    }, 5000);
    return () => clearInterval(interval);
  }, [room]);

  useEffect(() => {
    return () => { _connectGeneration++; if (roomRef.current) { roomRef.current.disconnect(); roomRef.current = null; _activeRoom = null; } };
  }, []);

  return { room, participants, isConnected, isConnecting, connectionError, connect, connectDm, disconnect, toggleMic, toggleCamera, toggleScreenShare };
}
