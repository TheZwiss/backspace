import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useVoicePeaks } from '../../hooks/useVoicePeaks';
import { formatVoiceDuration } from '../../utils/voiceMessage';

const BAR_COUNT = 44;
const SPEEDS = [1, 1.5, 2] as const;
/** Arrow keys on the waveform seek by this many seconds. */
const SEEK_STEP_S = 5;

/** The voice message that is playing, so starting another one pauses it. */
let playing: HTMLAudioElement | null = null;

interface VoiceMessagePlayerProps {
  url: string;
  mimetype: string;
  /** Duration in seconds when the server probed one; recorder files often have none until decoded. */
  durationHint?: number | null;
  federationBadge?: ReactNode;
}

/**
 * A voice message in the message list: a play/pause button, the waveform of
 * the recording, which fills as it plays and can be clicked, dragged or
 * arrow-keyed to seek, the time and a playback speed button. Only one plays
 * at a time.
 */
export function VoiceMessagePlayer({ url, mimetype, durationHint, federationBadge }: VoiceMessagePlayerProps) {
  const { t } = useTranslation(['chat']);
  const audioRef = useRef<HTMLAudioElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const peaks = useVoicePeaks(url, BAR_COUNT);
  const [isPlaying, setIsPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(durationHint && durationHint > 0 ? durationHint : 0);
  const [speedIndex, setSpeedIndex] = useState(0);
  const seeking = useRef(false);

  // A neutral waveform until the real one is decoded (or when it cannot be).
  const shape = useMemo(
    () => peaks ?? Array.from({ length: BAR_COUNT }, (_, i) => 0.28 + 0.12 * Math.sin(i * 0.9)),
    [peaks],
  );

  // A MediaRecorder file carries no duration; reading far past its end makes the
  // element work it out, after which playback starts from the beginning again.
  const onLoadedMetadata = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (Number.isFinite(audio.duration) && audio.duration > 0) { setDuration(audio.duration); return; }
    const resolve = () => {
      audio.removeEventListener('timeupdate', resolve);
      if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
      audio.currentTime = 0;
    };
    audio.addEventListener('timeupdate', resolve);
    audio.currentTime = 1e6;
  }, []);

  useEffect(() => () => { if (playing === audioRef.current) playing = null; }, []);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      if (playing && playing !== audio) playing.pause();
      playing = audio;
      void audio.play().catch(() => setIsPlaying(false));
    } else {
      audio.pause();
    }
  }, []);

  const seekToFraction = useCallback((fraction: number) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const next = Math.min(1, Math.max(0, fraction)) * duration;
    audio.currentTime = next;
    setTime(next);
  }, [duration]);

  const fractionAt = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = waveRef.current!.getBoundingClientRect();
    return (event.clientX - rect.left) / rect.width;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') seekToFraction((audio.currentTime + SEEK_STEP_S) / duration);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') seekToFraction((audio.currentTime - SEEK_STEP_S) / duration);
    else if (event.key === 'Home') seekToFraction(0);
    else if (event.key === 'End') seekToFraction(1);
    else return;
    event.preventDefault();
  };

  const cycleSpeed = () => {
    const next = (speedIndex + 1) % SPEEDS.length;
    setSpeedIndex(next);
    if (audioRef.current) audioRef.current.playbackRate = SPEEDS[next]!;
  };

  const fraction = duration > 0 ? Math.min(1, time / duration) : 0;
  const shownMs = (isPlaying || time > 0 ? time : duration) * 1000;
  const speed = SPEEDS[speedIndex]!;
  const speedLabel = `${speed}x`;

  return (
    <div className="mt-1 inline-flex max-w-full flex-col gap-1">
      <div
        role="group"
        aria-label={t('chat:attachment.voice.label', { duration: formatVoiceDuration(duration * 1000) })}
        className="flex w-[300px] max-w-full items-center gap-2.5 rounded-2xl border border-border-hard bg-surface-channel/50 py-2 pl-2 pr-3"
      >
        <audio
          ref={audioRef}
          preload="metadata"
          src={url}
          data-mimetype={mimetype}
          onLoadedMetadata={onLoadedMetadata}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => { setIsPlaying(false); setTime(0); if (audioRef.current) audioRef.current.currentTime = 0; }}
          onTimeUpdate={() => { if (!seeking.current && audioRef.current && audioRef.current.currentTime < 1e5) setTime(audioRef.current.currentTime); }}
        />
        <button
          type="button"
          data-icon-motion="none"
          onClick={toggle}
          aria-label={isPlaying ? t('chat:attachment.voice.pause') : t('chat:attachment.voice.play')}
          className="relative flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-accent-primary text-white transition-transform duration-150 hover:bg-accent-primary-hover active:scale-90"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={`absolute transition-all duration-200 ${isPlaying ? 'scale-50 opacity-0 rotate-90' : 'scale-100 opacity-100 rotate-0'}`}>
            <path d="M8 5.5v13a1 1 0 0 0 1.52.85l10.4-6.5a1 1 0 0 0 0-1.7L9.52 4.65A1 1 0 0 0 8 5.5Z" />
          </svg>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={`absolute transition-all duration-200 ${isPlaying ? 'scale-100 opacity-100 rotate-0' : 'scale-50 opacity-0 -rotate-90'}`}>
            <rect x="6" y="5" width="4.2" height="14" rx="1.4" />
            <rect x="13.8" y="5" width="4.2" height="14" rx="1.4" />
          </svg>
        </button>

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div
            ref={waveRef}
            role="slider"
            tabIndex={0}
            aria-label={t('chat:attachment.voice.seek')}
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(time)}
            aria-valuetext={`${formatVoiceDuration(time * 1000)} / ${formatVoiceDuration(duration * 1000)}`}
            onKeyDown={onKeyDown}
            onPointerDown={(event) => { seeking.current = true; event.currentTarget.setPointerCapture(event.pointerId); seekToFraction(fractionAt(event)); }}
            onPointerMove={(event) => { if (seeking.current) seekToFraction(fractionAt(event)); }}
            onPointerUp={(event) => { seeking.current = false; event.currentTarget.releasePointerCapture(event.pointerId); }}
            className="flex h-7 cursor-pointer touch-none items-center gap-[2px] rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
          >
            {shape.map((peak, i) => {
              const reached = (i + 0.5) / BAR_COUNT <= fraction;
              const current = isPlaying && Math.floor(fraction * BAR_COUNT) === i;
              return (
                <span
                  key={i}
                  aria-hidden="true"
                  className={`voice-wave-bar block w-[3px] flex-1 rounded-full ${reached ? 'bg-accent-primary' : 'bg-txt-tertiary/50'}`}
                  style={{ height: `${Math.max(14, peak * 100)}%`, transform: current ? 'scaleY(1.25)' : undefined }}
                />
              );
            })}
          </div>
          <div className="flex items-center justify-between text-ui-caption tabular-nums text-txt-tertiary">
            <span>{formatVoiceDuration(shownMs)}</span>
            <button
              type="button"
              data-icon-motion="none"
              onClick={cycleSpeed}
              aria-label={t('chat:attachment.voice.speed', { speed: speedLabel })}
              className={`rounded-full px-1.5 py-px font-medium transition-colors ${speed === 1 ? 'hover:text-txt-secondary' : 'bg-accent-primary/15 text-accent-primary'}`}
            >
              {speedLabel}
            </button>
          </div>
        </div>
      </div>
      {federationBadge}
    </div>
  );
}
