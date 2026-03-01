import React from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAudioTrackPlayer } from '../../hooks/useAudioTrackPlayer';
import type { ParticipantInfo } from '../../hooks/useLiveKit';

/**
 * Manages a Web Audio pipeline for a single audio track.
 * Renders a muted <audio> element as a Chrome keep-alive for the WebRTC track.
 * All actual audio output goes through Web Audio (GainNode -> ctx.destination).
 */
function AudioTrackElement({
  track,
  globalVolume,
  perSourceVolume,
  isDeafened,
  isMuted,
  attenuate,
  someoneIsSpeaking,
  attenuationEnabled,
  attenuationStrength,
}: {
  track: MediaStreamTrack | null;
  globalVolume: number;
  perSourceVolume: number;
  isDeafened: boolean;
  isMuted: boolean;
  attenuate: boolean;
  someoneIsSpeaking: boolean;
  attenuationEnabled: boolean;
  attenuationStrength: number;
}) {
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
  return <audio ref={audioRef} autoPlay playsInline data-backspace="keepalive" />;
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
  const speakingParticipantIds = useVoiceStore((s) => s.speakingParticipantIds);

  // Determine if someone is currently speaking (for stream attenuation)
  const someoneIsSpeaking = participants.some((p) => !p.isLocal && speakingParticipantIds.has(p.identity));

  // Only render audio for remote participants
  const remoteParticipants = participants.filter((p) => !p.isLocal);

  return (
    <>
      {remoteParticipants.map((p: ParticipantInfo) => {
        const micVolume = participantVolumes.get(p.userId) ?? 100;
        const streamVol = streamVolumes.get(p.userId) ?? 100;
        const isStreamMuted = streamMutes.get(p.userId) ?? false;

        return (
          <React.Fragment key={p.identity}>
            {/* Mic audio */}
            {p.audioTrack && (
              <AudioTrackElement
                track={p.audioTrack}
                globalVolume={outputVolume}
                perSourceVolume={micVolume}
                isDeafened={isDeafened}
                isMuted={false}
                attenuate={false}
                someoneIsSpeaking={false}
                attenuationEnabled={false}
                attenuationStrength={0}
              />
            )}

            {/* Screen share audio — only when user opted in to watch */}
            {p.screenAudioTrack && watchingStreams.has(p.userId) && (
              <AudioTrackElement
                track={p.screenAudioTrack}
                globalVolume={outputVolume}
                perSourceVolume={streamVol}
                isDeafened={isDeafened}
                isMuted={isStreamMuted}
                attenuate={true}
                someoneIsSpeaking={someoneIsSpeaking}
                attenuationEnabled={streamAttenuationEnabled}
                attenuationStrength={streamAttenuationStrength}
              />
            )}
          </React.Fragment>
        );
      })}
    </>
  );
}
