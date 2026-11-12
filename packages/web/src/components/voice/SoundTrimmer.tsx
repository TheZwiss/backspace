import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal';
import { Toggle } from '../ui/Toggle';
import { Tooltip } from '../ui/Tooltip';
import { useFormatters } from '../../i18n/formatters';
import { previewSoundboardCut, type TrimPreview } from '../../utils/soundboard';
import {
  MAX_CLIP_SECONDS,
  centreSelection,
  computePeaks,
  defaultSelection,
  moveEnd,
  moveStart,
  selectAudible,
  slideSelection,
  type ClipSelection,
} from '../../utils/audioTrim';

export interface SoundCut extends ClipSelection {
  /** Fade the first and last milliseconds so the cut does not click. */
  fade: boolean;
}

interface SoundTrimmerProps {
  isOpen: boolean;
  /** The decoded source file. */
  buffer: AudioBuffer;
  /** Shown in the header so the person knows which file they are cutting. */
  fileName: string;
  /** The cut to start from (a re-opened trimmer keeps the previous one). */
  initial?: SoundCut;
  onConfirm: (cut: SoundCut) => void;
  onCancel: () => void;
}

type DragMode = 'start' | 'end' | 'move';

const PEAK_BUCKETS = 480;
/** Arrow-key step, and the larger step with Shift. */
const KEY_STEP = 0.01;
const KEY_STEP_LARGE = 0.1;

/** `rgb(var(--token))` resolved to a concrete colour the canvas can paint with. */
function tokenColour(name: string, alpha: number, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw ? `rgb(${raw.replace(/\s+/g, ' ')} / ${alpha})` : fallback;
}

/**
 * Cuts a sound effect down to the soundboard's 5-second limit. A waveform shows
 * the whole file; a highlighted window marks what is kept. Drag its edges to
 * resize, drag the middle (or click the waveform) to slide it, or use the arrow
 * keys on a focused handle. The window can never exceed the limit, so whatever
 * is confirmed is always uploadable. Nothing here is sent anywhere: "Preview"
 * plays locally and the cut is rendered by the caller on confirm.
 */
export function SoundTrimmer({ isOpen, buffer, fileName, initial, onConfirm, onCancel }: SoundTrimmerProps) {
  const { t } = useTranslation(['voice', 'common']);
  const f = useFormatters();
  const duration = buffer.duration;
  const [selection, setSelection] = useState<ClipSelection>(() => initial ?? defaultSelection(duration));
  const [fade, setFade] = useState(initial?.fade ?? true);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ mode: DragMode; pointerX: number; origin: ClipSelection } | null>(null);
  const preview = useRef<TrimPreview | null>(null);
  const frame = useRef(0);

  const peaks = useMemo(() => {
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    return computePeaks(channels, PEAK_BUCKETS);
  }, [buffer]);

  const length = selection.end - selection.start;
  const overLimit = duration > MAX_CLIP_SECONDS;
  const seconds = (value: number) => t('voice:trimmer.seconds', { value: f.formatNumber(Math.round(value * 100) / 100) });

  // Waveform: peaks as mirrored bars, the kept window in the accent colour.
  useEffect(() => {
    const canvas = canvasRef.current;
    const track = trackRef.current;
    if (!isOpen || !canvas || !track) return;
    const draw = () => {
      const rect = track.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const kept = tokenColour('--accent-primary', 1, '#7c6cf6');
      const dim = tokenColour('--text-tertiary', 0.45, '#888');
      const barWidth = width / peaks.length;
      const mid = height / 2;
      peaks.forEach((peak, i) => {
        const time = ((i + 0.5) / peaks.length) * duration;
        context.fillStyle = time >= selection.start && time <= selection.end ? kept : dim;
        const bar = Math.max(1.5, peak * (height - 8));
        context.fillRect(i * barWidth, mid - bar / 2, Math.max(1, barWidth - 1), bar);
      });
    };
    draw();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(draw);
    observer?.observe(track);
    return () => observer?.disconnect();
  }, [isOpen, peaks, duration, selection.start, selection.end]);

  const stopPreview = useCallback(() => {
    cancelAnimationFrame(frame.current);
    preview.current?.stop();
    preview.current = null;
    setPlaying(false);
    setPlayhead(null);
  }, []);

  useEffect(() => stopPreview, [stopPreview]);
  useEffect(() => { if (!isOpen) stopPreview(); }, [isOpen, stopPreview]);

  const startPreview = useCallback(async (cut: ClipSelection) => {
    stopPreview();
    try {
      const running = await previewSoundboardCut(buffer, { ...cut, fade });
      preview.current = running;
      setPlaying(true);
      const tick = () => {
        setPlayhead(running.position());
        frame.current = requestAnimationFrame(tick);
      };
      tick();
      void running.ended.then(() => {
        if (preview.current !== running) return;
        cancelAnimationFrame(frame.current);
        preview.current = null;
        setPlaying(false);
        setPlayhead(null);
      });
    } catch {
      setPlaying(false);
    }
  }, [buffer, fade, stopPreview]);

  const togglePreview = () => { if (playing) stopPreview(); else void startPreview(selection); };

  /** Any edit stops the preview: it would be playing a cut that no longer exists. */
  const edit = (next: ClipSelection) => { if (playing) stopPreview(); setSelection(next); };

  const secondsAt = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * duration;
  };

  const beginDrag = (mode: DragMode) => (event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { mode, pointerX: event.clientX, origin: selection };
  };

  const onDragMove = (event: ReactPointerEvent<HTMLElement>) => {
    const active = drag.current;
    const rect = trackRef.current?.getBoundingClientRect();
    if (!active || !rect || rect.width === 0) return;
    const delta = ((event.clientX - active.pointerX) / rect.width) * duration;
    if (active.mode === 'start') edit(moveStart(active.origin, active.origin.start + delta, duration));
    else if (active.mode === 'end') edit(moveEnd(active.origin, active.origin.end + delta, duration));
    else edit(slideSelection(active.origin, delta, duration));
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onHandleKey = (mode: DragMode) => (event: ReactKeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const direction = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : 0;
    if (direction === 0) return;
    // The edge handles sit inside the window, whose own handler would slide the cut too.
    event.stopPropagation();
    event.preventDefault();
    if (mode === 'start') edit(moveStart(selection, selection.start + direction * step, duration));
    else if (mode === 'end') edit(moveEnd(selection, selection.end + direction * step, duration));
    else edit(slideSelection(selection, direction * step, duration));
  };

  const percent = (value: number) => `${(value / duration) * 100}%`;
  const channels = () => Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));

  return (
    <Modal isOpen={isOpen} onClose={onCancel} title={t('voice:trimmer.title')} maxWidth="max-w-2xl">
      <div className="space-y-4">
        <p className="text-sm text-txt-secondary">
          {overLimit
            ? t('voice:trimmer.tooLong', { file: fileName, total: seconds(duration), max: seconds(MAX_CLIP_SECONDS) })
            : t('voice:trimmer.fits', { file: fileName, total: seconds(duration), max: seconds(MAX_CLIP_SECONDS) })}
        </p>

        <div
          ref={trackRef}
          data-trimmer-track
          className="relative h-32 rounded-xl bg-surface-input overflow-hidden select-none touch-none cursor-pointer"
          onPointerDown={(event) => { edit(centreSelection(selection, secondsAt(event.clientX), duration)); }}
        >
          <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 w-full h-full" />
          <div
            data-trimmer-window
            className="absolute inset-y-0 border-y-2 border-accent-primary bg-accent-primary/10 cursor-grab active:cursor-grabbing"
            style={{ left: percent(selection.start), width: percent(length) }}
            onPointerDown={beginDrag('move')}
            onPointerMove={onDragMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            role="slider"
            tabIndex={0}
            aria-label={t('voice:trimmer.windowHandle')}
            aria-valuemin={0}
            aria-valuemax={Math.max(0, duration - length)}
            aria-valuenow={selection.start}
            aria-valuetext={t('voice:trimmer.windowValue', { start: seconds(selection.start), end: seconds(selection.end) })}
            onKeyDown={onHandleKey('move')}
          >
            {(['start', 'end'] as const).map((edge) => (
              <div
                key={edge}
                role="slider"
                tabIndex={0}
                aria-label={t(edge === 'start' ? 'voice:trimmer.startHandle' : 'voice:trimmer.endHandle')}
                aria-valuemin={0}
                aria-valuemax={duration}
                aria-valuenow={selection[edge]}
                aria-valuetext={seconds(selection[edge])}
                data-trimmer-handle={edge}
                className={`absolute inset-y-0 w-3 flex items-center justify-center bg-accent-primary cursor-ew-resize focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary ${edge === 'start' ? '-left-px rounded-l-md' : '-right-px rounded-r-md'}`}
                onPointerDown={beginDrag(edge)}
                onPointerMove={onDragMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={onHandleKey(edge)}
              >
                <span aria-hidden="true" className="h-6 w-0.5 rounded-full bg-white/80" />
              </div>
            ))}
          </div>
          {playhead !== null && (
            <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-0.5 bg-txt-primary" style={{ left: percent(playhead) }} />
          )}
        </div>

        <div className="grid grid-cols-3 gap-3 text-center" aria-live="polite">
          <div className="rounded-lg bg-wash/[0.04] p-2"><div className="text-ui-caption text-txt-tertiary">{t('voice:trimmer.start')}</div><div className="text-sm font-semibold text-txt-primary">{seconds(selection.start)}</div></div>
          <div className="rounded-lg bg-wash/[0.04] p-2"><div className="text-ui-caption text-txt-tertiary">{t('voice:trimmer.end')}</div><div className="text-sm font-semibold text-txt-primary">{seconds(selection.end)}</div></div>
          <div className="rounded-lg bg-accent-primary/10 p-2"><div className="text-ui-caption text-txt-tertiary">{t('voice:trimmer.length')}</div><div className="text-sm font-semibold text-txt-primary" data-trimmer-length>{seconds(length)}</div></div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button data-icon-motion="press" type="button" onClick={togglePreview} className="ui-button ui-button-secondary inline-flex items-center gap-2 px-3">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{playing ? <rect x="6" y="6" width="12" height="12" rx="2" /> : <path d="M8 5v14l11-7z" />}</svg>
            {playing ? t('voice:trimmer.stop') : t('voice:trimmer.preview')}
          </button>
          <Tooltip content={t('voice:trimmer.trimSilenceHint')} position="top">
            <button data-icon-motion="press" type="button" onClick={() => edit(selectAudible(channels(), buffer.sampleRate, duration))} className="ui-button ui-button-secondary px-3">{t('voice:trimmer.trimSilence')}</button>
          </Tooltip>
          <button data-icon-motion="press" type="button" onClick={() => edit(defaultSelection(duration))} className="ui-button ui-button-secondary px-3">{t('voice:trimmer.reset')}</button>
          <label className="ml-auto flex items-center gap-2 text-xs text-txt-secondary">
            {t('voice:trimmer.fade')}
            <Toggle enabled={fade} onChange={(value) => { if (playing) stopPreview(); setFade(value); }} ariaLabel={t('voice:trimmer.fade')} />
          </label>
        </div>

        <p className="text-xs text-txt-tertiary">{t('voice:trimmer.help')}</p>

        <div className="flex justify-end gap-2 pt-1">
          <button data-icon-motion="press" type="button" onClick={onCancel} className="ui-button ui-button-secondary px-4">{t('common:actions.cancel')}</button>
          <button data-icon-motion="press" type="button" onClick={() => { stopPreview(); onConfirm({ ...selection, fade }); }} className="ui-button ui-button-primary px-4">{t('voice:trimmer.apply')}</button>
        </div>
      </div>
    </Modal>
  );
}
