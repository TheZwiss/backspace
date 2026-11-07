import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { formatVoiceDuration, spectrumBars } from '../../utils/voiceMessage';

/** Bars in the live spectrum. */
const BAR_COUNT = 28;
/** A bar never shrinks below this fraction of its height, so silence still draws a line. */
const MIN_SCALE = 0.12;
/** How fast a bar falls back after a peak, per frame; rises are instant. */
const FALL_PER_FRAME = 0.12;

interface VoiceRecorderBarProps {
  elapsedMs: number;
  analyser: AnalyserNode | null;
  onCancel: () => void;
  onSend: () => void;
  /** The send is in progress (the file is being handed to the composer). */
  busy?: boolean;
}

/**
 * The composer row while a voice message is being recorded: cancel, a pulsing
 * recording dot with the elapsed time, the live frequency spectrum of the
 * microphone, and send. Enter sends and Escape cancels.
 */
export function VoiceRecorderBar({ elapsedMs, analyser, onCancel, onSend, busy = false }: VoiceRecorderBarProps) {
  const { t } = useTranslation(['chat']);
  const barRefs = useRef<Array<HTMLSpanElement | null>>([]);

  // The spectrum is drawn straight onto the bars on every frame: a React state
  // update at 60 Hz would re-render the whole row for nothing.
  useEffect(() => {
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const levels = new Array<number>(BAR_COUNT).fill(MIN_SCALE);
    let frame = 0;
    const draw = () => {
      analyser.getByteFrequencyData(data);
      const targets = spectrumBars(data, BAR_COUNT);
      for (let i = 0; i < BAR_COUNT; i++) {
        const target = Math.max(MIN_SCALE, targets[i]!);
        levels[i] = target > levels[i]! ? target : Math.max(target, levels[i]! - FALL_PER_FRAME);
        const bar = barRefs.current[i];
        if (bar) bar.style.transform = `scaleY(${levels[i]!.toFixed(3)})`;
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [analyser]);

  // Escape cancels and Enter sends, wherever focus is while recording.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
      else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!busy) onSend(); }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel, onSend, busy]);

  return (
    <div role="group" aria-label={t('chat:composer.voice.recording')} className="voice-rec-enter flex items-center gap-2 pl-2 desktop:pl-[10px] pr-2 desktop:pr-2 min-h-[46px]">
      <button
        type="button"
        data-icon-motion="press"
        onClick={onCancel}
        title={t('chat:composer.voice.cancel')}
        aria-label={t('chat:composer.voice.cancel')}
        className="group w-10 h-10 desktop:w-[34px] desktop:h-[34px] flex items-center justify-center rounded-[6px] text-txt-tertiary hover:text-accent-rose hover:bg-accent-rose/10 transition-colors flex-shrink-0"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
          <path className="origin-[4px_7px] transition-transform duration-200 group-hover:-rotate-[18deg]" d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7" />
        </svg>
      </button>

      <span className="relative flex w-3 h-3 items-center justify-center flex-shrink-0" aria-hidden="true">
        <span className="voice-rec-ring absolute inset-0 rounded-full bg-accent-rose motion-reduce:hidden" />
        <span className="voice-rec-dot relative w-2.5 h-2.5 rounded-full bg-accent-rose" />
      </span>
      <span role="timer" aria-live="off" className="text-ui-body font-medium tabular-nums text-txt-primary w-11 flex-shrink-0">
        {formatVoiceDuration(elapsedMs)}
      </span>

      <div className="flex-1 min-w-0 h-8 flex items-center justify-center gap-[3px] overflow-hidden" aria-hidden="true">
        {Array.from({ length: BAR_COUNT }, (_, i) => (
          <span
            key={i}
            ref={(element) => { barRefs.current[i] = element; }}
            className="voice-bar w-[3px] h-7 rounded-full bg-accent-primary flex-shrink-0"
            style={{ transform: `scaleY(${MIN_SCALE})`, opacity: 0.55 + 0.45 * Math.sin((Math.PI * (i + 1)) / (BAR_COUNT + 1)) }}
          />
        ))}
      </div>

      <button
        type="button"
        data-icon-motion="send"
        onClick={onSend}
        disabled={busy}
        title={t('chat:composer.voice.send')}
        aria-label={t('chat:composer.voice.send')}
        className="voice-send-pop w-10 h-10 desktop:w-[34px] desktop:h-[34px] flex items-center justify-center rounded-[6px] bg-accent-primary hover:bg-accent-primary-hover text-white transition-colors flex-shrink-0 disabled:opacity-50"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M3.4 20.4l17.45-7.48a1 1 0 000-1.84L3.4 3.6a.993.993 0 00-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z" />
        </svg>
      </button>
    </div>
  );
}
