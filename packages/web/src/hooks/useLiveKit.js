import { useState, useCallback, useRef, useEffect } from 'react';
import { Room, RoomEvent, Track, ConnectionState, VideoPresets, VideoPreset, } from 'livekit-client';
import { api } from '../api/client';
import { useVoiceStore } from '../stores/voiceStore';
import { AudioManager } from '../audio/AudioManager';
/**
 * OPENCORD NATIVE OVERDRIVE PIPELINE v32
 */
const QUALITY_MAP = {
    '1080p60': new VideoPreset(1920, 1080, 12_000_000, 60),
    '1080p': new VideoPreset(1920, 1080, 8_000_000, 30),
    '720p60': new VideoPreset(1280, 720, 8_000_000, 60),
    '720p': new VideoPreset(1280, 720, 4_000_000, 30),
    '540p': new VideoPreset(960, 540, 2_000_000, 30),
    '360p': new VideoPreset(640, 360, 1_000_000, 30),
};
const AUTO_PRESET = QUALITY_MAP['720p60'];
let _activeRoom = null;
export function getActiveRoom() {
    return _activeRoom;
}
export function deriveGridTiles(participants) {
    const tiles = [];
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
export function setStreamSubscription(room, targetIdentity, subscribed) {
    if (!room)
        return;
    const rp = room.remoteParticipants.get(targetIdentity);
    if (!rp)
        return;
    rp.trackPublications.forEach((pub) => {
        if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) {
            pub.setSubscribed(subscribed);
        }
    });
}
function parseIdentity(identity) {
    const parts = identity.split(':');
    return { userId: parts[0] ?? identity, username: parts[1] ?? identity };
}
let _connectGeneration = 0;
async function applyOverdriveHammer(room, source, preset) {
    try {
        const pub = room.localParticipant.getTrackPublications().find(p => p.source === source);
        if (!pub?.track)
            return;
        const engine = room.engine;
        const pc = engine?.pcManager?.publisher?.pc || engine?.publisher?.pc || engine?.pc;
        if (pc) {
            const senders = pc.getSenders();
            const sender = senders.find(s => s.track?.id === pub.track.mediaStreamTrack?.id);
            if (sender) {
                const params = sender.getParameters();
                if (params.encodings && params.encodings[0]) {
                    params.encodings[0].maxBitrate = preset.encoding.maxBitrate;
                    params.encodings[0].minBitrate = 2_000_000;
                    params.encodings[0].maxFramerate = preset.encoding.maxFramerate;
                    params.encodings[0].networkPriority = 'high';
                    // @ts-ignore
                    params.degradationPreference = 'maintain-framerate';
                    await sender.setParameters(params);
                }
            }
        }
    }
    catch (err) { }
}
export function useLiveKit() {
    const [room, setRoom] = useState(null);
    const [participants, setParticipants] = useState([]);
    const [isConnected, setIsConnected] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const [connectionState, setConnectionState] = useState(ConnectionState.Disconnected);
    const [connectedChannelId, setConnectedChannelId] = useState(null);
    const [connectionError, setConnectionError] = useState(null);
    const roomRef = useRef(null);
    const connectedChannelRef = useRef(null);
    const isMuted = useVoiceStore((s) => s.isMuted);
    const isDeafened = useVoiceStore((s) => s.isDeafened);
    const isCameraOn = useVoiceStore((s) => s.isCameraOn);
    const isScreenSharing = useVoiceStore((s) => s.isScreenSharing);
    const videoQuality = useVoiceStore((s) => s.videoQuality);
    const voiceUserStates = useVoiceStore((s) => s.voiceUserStates);
    const inputVolume = useVoiceStore((s) => s.inputVolume);
    const inputDeviceId = useVoiceStore((s) => s.inputDeviceId);
    const updateParticipants = useCallback(() => {
        const r = roomRef.current;
        if (!r)
            return;
        const allParticipants = [];
        const processParticipant = (p, isLocal) => {
            if (!p.identity)
                return;
            const { userId, username } = parseIdentity(p.identity);
            let audioTrack = null;
            let videoTrack = null;
            let screenTrack = null;
            let screenAudioTrack = null;
            let hasScreenSharePublication = false;
            p.trackPublications.forEach((pub) => {
                // Detect screen share publication even if unsubscribed
                if (pub.source === Track.Source.ScreenShare)
                    hasScreenSharePublication = true;
                const track = pub.track;
                if (!track)
                    return;
                // Strict check: Track must be subscribed AND not muted to be considered "active"
                if (pub.isMuted || !pub.isSubscribed)
                    return;
                const mt = track.mediaStreamTrack;
                if (!mt || mt.readyState !== 'live')
                    return;
                if (pub.source === Track.Source.Microphone)
                    audioTrack = mt;
                else if (pub.source === Track.Source.Camera && p.isCameraEnabled)
                    videoTrack = mt;
                else if (pub.source === Track.Source.ScreenShare)
                    screenTrack = mt;
                else if (pub.source === Track.Source.ScreenShareAudio)
                    screenAudioTrack = mt;
            });
            const userState = useVoiceStore.getState().voiceUserStates.get(userId);
            let isPartDeafened = false;
            let isPartMuted = !p.isMicrophoneEnabled;
            if (isLocal) {
                isPartDeafened = useVoiceStore.getState().isDeafened;
                isPartMuted = useVoiceStore.getState().isMuted;
            }
            else {
                isPartDeafened = userState?.isDeafened ?? useVoiceStore.getState().deafenedUserIds.has(userId);
                if (userState)
                    isPartMuted = userState.isMuted;
            }
            allParticipants.push({
                identity: p.identity,
                userId,
                username,
                isSpeaking: p.isSpeaking,
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
        setParticipants(allParticipants);
    }, []);
    const handleDataReceived = useCallback((payload, participant) => {
        try {
            const text = new TextDecoder().decode(payload);
            const msg = JSON.parse(text);
            if (msg.type === 'deafen' && participant) {
                const { userId } = parseIdentity(participant.identity);
                useVoiceStore.getState().setUserDeafened(userId, msg.deafened === true);
                updateParticipants();
            }
        }
        catch { }
    }, [updateParticipants]);
    // Handle Input Device & Mute Logic via AudioManager
    useEffect(() => {
        const r = roomRef.current;
        if (!r || !isConnected)
            return;
        const syncMic = async () => {
            try {
                const audioManager = AudioManager.getInstance();
                // If muted or deafened, unpublish mic
                if (isMuted || isDeafened) {
                    const pub = r.localParticipant.getTrackPublications().find(p => p.source === Track.Source.Microphone);
                    if (pub) {
                        await r.localParticipant.unpublishTrack(pub.track);
                    }
                    return;
                }
                // Ensure device is set and volume is sync'd
                await audioManager.setInputDevice(inputDeviceId);
                audioManager.setInputVolume(inputVolume);
                // Check if already published
                const existingPub = r.localParticipant.getTrackPublications().find(p => p.source === Track.Source.Microphone);
                if (existingPub && existingPub.track) {
                    // If track is alive, we are good.
                    if (existingPub.track.mediaStreamTrack?.readyState === 'live') {
                        return;
                    }
                    // If track died, unpublish so we can republish
                    await r.localParticipant.unpublishTrack(existingPub.track);
                }
                // Get a FRESH track (clone) for this specific publication
                const audioTrack = audioManager.getFreshTrack();
                if (!audioTrack)
                    return;
                console.log('[LiveKit] Publishing fresh microphone track');
                await r.localParticipant.publishTrack(audioTrack, {
                    name: 'microphone',
                    source: Track.Source.Microphone,
                });
            }
            catch (err) {
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
    }, [isMuted, isDeafened, inputDeviceId, inputVolume, isConnected]);
    const connect = useCallback(async (channelId) => {
        if (connectedChannelRef.current === channelId && roomRef.current?.state === ConnectionState.Connected)
            return;
        const gen = ++_connectGeneration;
        // 1. Reset state immediately to reflect "Loading/Switching" in UI
        setRoom(null);
        setParticipants([]);
        setIsConnected(false);
        setIsConnecting(true);
        setConnectionState(ConnectionState.Connecting);
        setConnectionError(null);
        setConnectedChannelId(null); // Clear this so AppLayout knows we are transitioning
        useVoiceStore.getState().setIsLiveKitConnected(false);
        // 2. Strictly disconnect previous room (Local Ref OR Global Ref)
        // This handles cases where AppLayout might have remounted, losing roomRef but leaving _activeRoom alive.
        const roomToDisconnect = roomRef.current || _activeRoom;
        if (roomToDisconnect) {
            try {
                console.log('[LiveKit] Disconnecting previous room:', roomToDisconnect.name);
                await roomToDisconnect.disconnect();
            }
            catch (err) {
                console.warn('Error disconnecting from previous room:', err);
            }
            roomRef.current = null;
            _activeRoom = null;
        }
        try {
            const { token, url } = await api.livekit.token(channelId);
            if (gen !== _connectGeneration)
                return;
            const newRoom = new Room({ adaptiveStream: false, dynacast: false, publishDefaults: { videoCodec: 'h264', simulcast: false } });
            roomRef.current = newRoom;
            const guardedUpdate = () => { if (roomRef.current === newRoom)
                updateParticipants(); };
            // ... existing event listeners ...
            newRoom.on(RoomEvent.ParticipantConnected, (participant) => {
                guardedUpdate();
                if (useVoiceStore.getState().isDeafened) {
                    const encoder = new TextEncoder();
                    newRoom.localParticipant.publishData(encoder.encode(JSON.stringify({ type: 'deafen', deafened: true })), { reliable: true }).catch(() => { });
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
            newRoom.on(RoomEvent.TrackPublished, (publication, participant) => {
                if (publication.source === Track.Source.ScreenShare) {
                    const { userId } = parseIdentity(participant.identity);
                    useVoiceStore.getState().watchStream(userId);
                }
                guardedUpdate();
            });
            newRoom.on(RoomEvent.TrackUnpublished, (publication, participant) => {
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
                if (roomRef.current !== newRoom)
                    return;
                setConnectionState(ConnectionState.Disconnected);
                setConnectedChannelId(null);
                roomRef.current = null;
                _activeRoom = null;
                setIsConnected(false);
                setRoom(null);
                setParticipants([]);
                useVoiceStore.getState().setIsLiveKitConnected(false);
            });
            await newRoom.connect(url, token);
            if (gen !== _connectGeneration) {
                newRoom.disconnect();
                return;
            }
            _activeRoom = newRoom;
            connectedChannelRef.current = channelId;
            setConnectedChannelId(channelId);
            setRoom(newRoom);
            setIsConnected(true);
            useVoiceStore.getState().setIsLiveKitConnected(true);
            updateParticipants();
            // Initial mute state check
            const { isMuted: wasMuted, isDeafened: wasDeafened } = useVoiceStore.getState();
            useVoiceStore.setState({ isCameraOn: false, isScreenSharing: false });
            if (wasDeafened) {
                newRoom.remoteParticipants.forEach((p) => p.setVolume(0));
            }
            updateParticipants();
        }
        catch (err) {
            if (gen === _connectGeneration)
                setConnectionError('Failed to connect');
        }
        finally {
            if (gen === _connectGeneration)
                setIsConnecting(false);
        }
    }, [updateParticipants, handleDataReceived]);
    const connectDm = useCallback(async (dmChannelId) => {
        const gen = ++_connectGeneration;
        // 1. Reset state immediately
        setRoom(null);
        setParticipants([]);
        setIsConnected(false);
        setIsConnecting(true);
        setConnectionState(ConnectionState.Connecting);
        setConnectionError(null);
        setConnectedChannelId(null);
        // 2. Strictly disconnect previous room (Local Ref OR Global Ref)
        const roomToDisconnect = roomRef.current || _activeRoom;
        if (roomToDisconnect) {
            try {
                console.log('[LiveKit] Disconnecting previous room (DM):', roomToDisconnect.name);
                await roomToDisconnect.disconnect();
            }
            catch (err) {
                console.warn('Error disconnecting from previous room:', err);
            }
            roomRef.current = null;
            _activeRoom = null;
        }
        try {
            const { token, url } = await api.livekit.dmToken(dmChannelId);
            if (gen !== _connectGeneration)
                return;
            const newRoom = new Room({ adaptiveStream: false, dynacast: false, publishDefaults: { videoCodec: 'h264', simulcast: false } });
            roomRef.current = newRoom;
            const guardedUpdate = () => { if (roomRef.current === newRoom)
                updateParticipants(); };
            newRoom.on(RoomEvent.ParticipantConnected, guardedUpdate);
            newRoom.on(RoomEvent.ParticipantDisconnected, guardedUpdate);
            newRoom.on(RoomEvent.TrackSubscribed, guardedUpdate);
            newRoom.on(RoomEvent.TrackUnsubscribed, guardedUpdate);
            newRoom.on(RoomEvent.LocalTrackPublished, guardedUpdate);
            newRoom.on(RoomEvent.LocalTrackUnpublished, guardedUpdate);
            newRoom.on(RoomEvent.TrackMuted, guardedUpdate);
            newRoom.on(RoomEvent.TrackUnmuted, guardedUpdate);
            newRoom.on(RoomEvent.ActiveSpeakersChanged, guardedUpdate);
            newRoom.on(RoomEvent.TrackPublished, (publication, participant) => {
                if (publication.source === Track.Source.ScreenShare) {
                    const { userId } = parseIdentity(participant.identity);
                    useVoiceStore.getState().watchStream(userId);
                }
                guardedUpdate();
            });
            newRoom.on(RoomEvent.TrackUnpublished, (publication, participant) => {
                if (publication.source === Track.Source.ScreenShare) {
                    const { userId } = parseIdentity(participant.identity);
                    const state = useVoiceStore.getState();
                    state.unwatchStream(userId);
                    state.clearStreamVolume(userId);
                    state.clearStreamMute(userId);
                }
                guardedUpdate();
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
            if (gen !== _connectGeneration) {
                newRoom.disconnect();
                return;
            }
            const fullId = `dm-${dmChannelId}`;
            _activeRoom = newRoom;
            connectedChannelRef.current = fullId;
            setConnectedChannelId(fullId);
            setRoom(newRoom);
            setIsConnected(true);
            useVoiceStore.getState().setIsLiveKitConnected(true);
            updateParticipants();
            const { isMuted: wasMuted, isDeafened: wasDeafened } = useVoiceStore.getState();
            useVoiceStore.setState({ isCameraOn: false, isScreenSharing: false });
            if (wasDeafened) {
                newRoom.remoteParticipants.forEach((p) => p.setVolume(0));
            }
            updateParticipants();
        }
        catch (err) {
            if (gen === _connectGeneration)
                setConnectionError('Failed to connect');
        }
        finally {
            if (gen === _connectGeneration)
                setIsConnecting(false);
        }
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
            setParticipants([]);
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
                setTimeout(() => { if (roomRef.current)
                    applyOverdriveHammer(roomRef.current, Track.Source.Camera, preset); }, 2000);
            }
            else {
                await roomRef.current.localParticipant.setCameraEnabled(false);
            }
            updateParticipants();
        }
    }, [isCameraOn, videoQuality, updateParticipants]);
    const toggleScreenShare = useCallback(async () => {
        if (roomRef.current) {
            if (!isScreenSharing) {
                const preset = QUALITY_MAP[videoQuality] || AUTO_PRESET;
                const track = await roomRef.current.localParticipant.setScreenShareEnabled(true, {
                    audio: true,
                    resolution: VideoPresets.h360.resolution,
                    // @ts-ignore
                    frameRate: 30,
                }, {
                    videoCodec: 'h264', videoEncoding: VideoPresets.h360.encoding, simulcast: false, priority: 'very-high'
                });
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
                    setTimeout(() => applyOverdriveHammer(roomRef.current, Track.Source.ScreenShare, preset), 5000);
                }
            }
            else {
                await roomRef.current.localParticipant.setScreenShareEnabled(false);
            }
            updateParticipants();
        }
    }, [isScreenSharing, videoQuality, updateParticipants]);
    useEffect(() => {
        updateParticipants();
    }, [voiceUserStates, isMuted, isDeafened, updateParticipants]);
    useEffect(() => {
        if (!room)
            return;
        const preset = QUALITY_MAP[videoQuality] || AUTO_PRESET;
        const updateActiveTracks = async () => {
            if (isScreenSharing) {
                const screenPub = room.localParticipant.getTrackPublications().find(p => p.source === Track.Source.ScreenShare);
                if (screenPub?.videoTrack) {
                    const mediaTrack = screenPub.videoTrack.mediaStreamTrack;
                    if (mediaTrack) {
                        await mediaTrack.applyConstraints({ width: { ideal: preset.resolution.width }, height: { ideal: preset.resolution.height }, frameRate: { ideal: preset.encoding.maxFramerate } });
                    }
                    await applyOverdriveHammer(room, Track.Source.ScreenShare, preset);
                }
            }
            if (isCameraOn) {
                await applyOverdriveHammer(room, Track.Source.Camera, preset);
            }
        };
        updateActiveTracks().catch(() => { });
    }, [room, videoQuality, isScreenSharing, isCameraOn]);
    useEffect(() => {
        if (!room)
            return;
        const interval = setInterval(async () => {
            try {
                const engine = room.engine;
                const pc = engine?.pcManager?.publisher?.pc || engine?.publisher?.pc || engine?.pc || room.pc;
                if (!pc)
                    return;
                const stats = await pc.getStats();
                stats.forEach((report) => {
                    if (report.type === 'outbound-rtp' && report.kind === 'video' && report.frameWidth > 0) {
                        const fps = Math.round(report.framesPerSecond || 0);
                        const key = `_lastBytes_${report.ssrc}`;
                        const lastBytes = window[key] || report.bytesSent;
                        const bitrate = (((report.bytesSent - lastBytes) * 8) / 5000 / 1000).toFixed(2);
                        window[key] = report.bytesSent;
                        console.log(`[Soft-Launch Diagnostic] ${report.frameWidth}x${report.frameHeight} @ ${fps} FPS (~${bitrate} Mbps) | ${report.qualityLimitationReason}`);
                    }
                });
            }
            catch (err) { }
        }, 5000);
        return () => clearInterval(interval);
    }, [room]);
    useEffect(() => {
        return () => { _connectGeneration++; if (roomRef.current) {
            roomRef.current.disconnect();
            roomRef.current = null;
            _activeRoom = null;
        } };
    }, []);
    return { room, participants, isConnected, isConnecting, connectionState, connectedChannelId, connectionError, connect, connectDm, disconnect, toggleMic, toggleCamera, toggleScreenShare };
}
