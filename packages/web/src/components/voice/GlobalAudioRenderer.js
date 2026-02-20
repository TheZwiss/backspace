import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAudioTrackPlayer } from '../../hooks/useAudioTrackPlayer';
/**
 * Manages a Web Audio pipeline for a single audio track.
 * Renders a muted <audio> element as a Chrome keep-alive for the WebRTC track.
 * All actual audio output goes through Web Audio (GainNode -> ctx.destination).
 */
function AudioTrackElement({ track, globalVolume, perSourceVolume, isDeafened, isMuted, attenuate, someoneIsSpeaking, attenuationEnabled, attenuationStrength, }) {
    const globalScale = globalVolume / 100;
    const sourceScale = perSourceVolume / 100;
    let finalVolume = globalScale * sourceScale;
    // Stream attenuation: duck when someone is speaking
    if (attenuate && attenuationEnabled && someoneIsSpeaking) {
        finalVolume *= 1 - attenuationStrength / 100;
    }
    const shouldMute = isDeafened || isMuted;
    const audioRef = useAudioTrackPlayer({
        track,
        volume: finalVolume,
        muted: shouldMute,
    });
    // The <audio> element is always muted — it serves only as a Chrome
    // keep-alive so Chrome continues processing the WebRTC track.
    // Real audio output goes through the Web Audio pipeline.
    return _jsx("audio", { ref: audioRef, autoPlay: true, playsInline: true, "data-opencord": "keepalive" });
}
/**
 * Always-mounted component that manages Web Audio pipelines
 * for every remote participant's mic and screen audio tracks.
 *
 * Rendered in AppLayout alongside PictureInPicture and SoundController.
 * Never unmounts during navigation, so audio persists even when
 * VoiceGrid / VoiceUser / StreamTile are not rendered.
 *
 * All audio is routed through the Web Audio API (GainNodes connected
 * to a shared AudioContext.destination). Muted <audio> elements serve
 * as Chrome keep-alives for WebRTC tracks but produce no sound.
 */
export function GlobalAudioRenderer() {
    const participants = useVoiceStore((s) => s.participants);
    const isDeafened = useVoiceStore((s) => s.isDeafened);
    const outputVolume = useVoiceStore((s) => s.outputVolume);
    const participantVolumes = useVoiceStore((s) => s.participantVolumes);
    const streamVolumes = useVoiceStore((s) => s.streamVolumes);
    const streamMutes = useVoiceStore((s) => s.streamMutes);
    const watchingStreams = useVoiceStore((s) => s.watchingStreams);
    const streamAttenuationEnabled = useVoiceStore((s) => s.streamAttenuationEnabled);
    const streamAttenuationStrength = useVoiceStore((s) => s.streamAttenuationStrength);
    // Determine if someone is currently speaking (for stream attenuation)
    const someoneIsSpeaking = participants.some((p) => !p.isLocal && p.isSpeaking);
    // Only render audio for remote participants
    const remoteParticipants = participants.filter((p) => !p.isLocal);
    return (_jsx(_Fragment, { children: remoteParticipants.map((p) => {
            const micVolume = participantVolumes.get(p.userId) ?? 100;
            const streamVol = streamVolumes.get(p.userId) ?? 100;
            const isStreamMuted = streamMutes.get(p.userId) ?? false;
            return (_jsxs(React.Fragment, { children: [p.audioTrack && (_jsx(AudioTrackElement, { track: p.audioTrack, globalVolume: outputVolume, perSourceVolume: micVolume, isDeafened: isDeafened, isMuted: false, attenuate: false, someoneIsSpeaking: false, attenuationEnabled: false, attenuationStrength: 0 })), p.screenAudioTrack && watchingStreams.has(p.userId) && (_jsx(AudioTrackElement, { track: p.screenAudioTrack, globalVolume: outputVolume, perSourceVolume: streamVol, isDeafened: isDeafened, isMuted: isStreamMuted, attenuate: true, someoneIsSpeaking: someoneIsSpeaking, attenuationEnabled: streamAttenuationEnabled, attenuationStrength: streamAttenuationStrength }))] }, p.identity));
        }) }));
}
