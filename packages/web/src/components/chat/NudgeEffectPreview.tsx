import { useEffect, useState } from 'react';
import type { NudgeEffect } from '@backspace/shared';

/** Effects drawn as a miniature screen with the effect itself running on it. */
const SCREEN_EFFECTS = ['shake', 'wave', 'jelly', 'confetti', 'pulse'] as const;
type ScreenEffect = typeof SCREEN_EFFECTS[number];

function isScreenEffect(effect: NudgeEffect): effect is ScreenEffect {
  return (SCREEN_EFFECTS as readonly string[]).includes(effect);
}

/**
 * The still and the animation of an effect that plays a recorded clip: the
 * knock and every MSN wink. Both are frames of the real clip the friend's
 * screen plays (`public/nudge-previews`, cut from the desktop app's own
 * assets); the still shows at rest, the animation while the entry is active.
 */
export function previewAssets(effect: NudgeEffect): { still: string; animated: string } {
  const name = effect.startsWith('msn_') ? effect.slice('msn_'.length) : effect;
  return { still: `/nudge-previews/${name}.png`, animated: `/nudge-previews/${name}.webp` };
}

/** Columns the miniature wave is cut into; the real effect uses 24. */
const WAVE_COLUMNS = 9;
const CONFETTI_PIECES = 9;
const CONFETTI_COLORS = ['#7c6cf6', '#c4b5fd', '#86efac', '#fca5a5', '#fcd34d'];

/** The desktop picture the effect plays over: a window with a title bar and lines of text. */
function MiniDesktopContent() {
  return (
    <span className="nudge-mini-content">
      <span className="nudge-mini-bar" />
      <span className="nudge-mini-line w-3/4" />
      <span className="nudge-mini-line w-1/2" />
      <span className="nudge-mini-line w-2/3" />
    </span>
  );
}

function ScreenPreview({ effect }: { effect: ScreenEffect }) {
  return (
    <span className="nudge-mini" data-effect={effect}>
      {effect === 'wave'
        ? Array.from({ length: WAVE_COLUMNS }, (_, i) => (
          <span key={i} className="nudge-mini-wave-column" style={{ left: `${(i * 100) / WAVE_COLUMNS}%`, width: `${100 / WAVE_COLUMNS + 1}%`, animationDelay: `${-i * 110}ms` }}>
            <span className="nudge-mini-wave-content" style={{ left: `${-i * 100}%`, width: `${WAVE_COLUMNS * 100}%` }}><MiniDesktopContent /></span>
          </span>
        ))
        : <MiniDesktopContent />}
      {effect === 'confetti' && Array.from({ length: CONFETTI_PIECES }, (_, i) => (
        <span
          key={i}
          className="nudge-mini-confetti"
          style={{
            background: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
            ['--confetti-x' as string]: `${Math.cos(i * 2.4) * 22}px`,
            ['--confetti-y' as string]: `${12 + (i % 4) * 5}px`,
            animationDelay: `${-i * 130}ms`,
          }}
        />
      ))}
    </span>
  );
}

/**
 * A preview of what an attention effect does on the friend's screen, for its
 * menu entry. The five screen effects run as a miniature of the real effect
 * (a shaking window, a travelling wave, a wobbling jelly, falling confetti, a
 * glowing border), frozen on a telling frame until `active`. The knock and the
 * MSN winks show frames of the actual clip.
 */
export function NudgeEffectPreview({ effect, active }: { effect: NudgeEffect; active: boolean }) {
  if (isScreenEffect(effect)) {
    return <span aria-hidden="true" className="nudge-preview" data-active={active}><ScreenPreview effect={effect} /></span>;
  }
  return <ClipPreview effect={effect} active={active} />;
}

/**
 * The clip's still, swapped for its animation while `active`. The animation is
 * fetched on the first activation and only shown once it has loaded, so the
 * picture never goes blank or jumps in half-loaded; it then plays from its
 * first frame each time the entry is activated.
 */
function ClipPreview({ effect, active }: { effect: NudgeEffect; active: boolean }) {
  const { still, animated } = previewAssets(effect);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!active || ready) return;
    const image = new Image();
    image.onload = () => setReady(true);
    image.src = animated;
    return () => { image.onload = null; };
  }, [active, ready, animated]);
  const playing = active && ready;
  return (
    <span aria-hidden="true" className="nudge-preview nudge-preview-clip" data-active={active}>
      {/* Keyed so the animation restarts from its first frame on every activation. */}
      <img key={playing ? 'playing' : 'still'} src={playing ? animated : still} alt="" width={56} height={42} draggable={false} className="h-full w-full object-contain" />
    </span>
  );
}
