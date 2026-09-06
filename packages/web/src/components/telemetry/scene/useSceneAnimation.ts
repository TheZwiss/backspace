import { useEffect, useRef } from 'react';
import type { SceneMood } from './HelloScene';
import { ARM_REST_DEG } from './Pilot';

const EASING = {
  gentle: 'cubic-bezier(0.4, 0, 0.2, 1)',
  softOut: 'cubic-bezier(0, 0, 0.2, 1)',
} as const;

const CROSS_FADE_MS = 200;
/** How long the goodbye wave takes; the ask holds the farewell on screen for it. */
export const FAREWELL_WAVE_MS = 1500;
const BEAM_OPACITY = 0.6;

// The arm's current rotation in degrees, read from its computed transform so
// the choreography starts where the ambient wave left it instead of snapping.
function currentAngle(el: Element): number {
  const value = window.getComputedStyle(el).transform;
  const match = /^matrix\(([^,]+),([^,]+),/.exec(value);
  if (!match || match[1] === undefined || match[2] === undefined) return 0;
  const a = Number.parseFloat(match[1]);
  const b = Number.parseFloat(match[2]);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return (Math.atan2(b, a) * 180) / Math.PI;
}

function rotate(deg: number): string {
  return `rotate(${deg.toFixed(2)}deg)`;
}

export function useSceneAnimation(svgRef: React.RefObject<SVGSVGElement | null>, mood: SceneMood): void {
  const previousMood = useRef<SceneMood | null>(null);

  useEffect(() => {
    const previous = previousMood.current;
    previousMood.current = mood;
    const svg = svgRef.current;
    if (!svg) return;

    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const running: Animation[] = [];

    const part = (name: string): Element | null => svg.querySelector(`[data-part="${name}"]`);
    const parts = (name: string): Element[] => Array.from(svg.querySelectorAll(`[data-part="${name}"]`));

    function play(el: Element | null, keyframes: Keyframe[], options: KeyframeAnimationOptions): void {
      if (!el || typeof el.animate !== 'function') return;
      running.push(el.animate(keyframes, options));
    }

    function cancelAll(): void {
      for (const animation of running) {
        try {
          animation.cancel();
        } catch {
          // Already removed by the browser; nothing left to cancel.
        }
      }
      running.length = 0;
    }

    function happy(): void {
      play(part('lit'), [{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: EASING.softOut, fill: 'forwards' });
      play(
        part('glow'),
        [{ opacity: 0.4, transform: 'scale(1)' }, { opacity: 0.85, transform: 'scale(1.2)' }],
        { duration: 300, easing: EASING.softOut, fill: 'forwards' },
      );
      play(
        part('ray'),
        [
          { transform: 'scaleX(0)', opacity: 0 },
          { opacity: BEAM_OPACITY, offset: 0.3 },
          { transform: 'scaleX(1)', opacity: BEAM_OPACITY },
        ],
        { duration: 900, delay: 200, easing: EASING.softOut, fill: 'forwards' },
      );
      parts('pulse').forEach((star, i) => {
        play(
          star,
          [{ transform: 'scale(1)' }, { transform: 'scale(1.8)', opacity: 1, offset: 0.5 }, { transform: 'scale(1)' }],
          { duration: 400, delay: 600 + i * 40, easing: EASING.gentle },
        );
      });
      const arm = part('arm');
      if (arm) {
        play(arm, [{ transform: rotate(currentAngle(arm)) }, { transform: rotate(2) }], {
          duration: 400,
          easing: EASING.gentle,
          fill: 'forwards',
        });
      }
    }

    function farewell(): void {
      const arm = part('arm');
      if (!arm) return;
      play(
        arm,
        [
          { transform: rotate(currentAngle(arm)), offset: 0 },
          { transform: rotate(-12), offset: 0.2 },
          { transform: rotate(22), offset: 0.45 },
          { transform: rotate(-8), offset: 0.68 },
          { transform: rotate(ARM_REST_DEG), offset: 1 },
        ],
        { duration: FAREWELL_WAVE_MS, easing: EASING.gentle, fill: 'forwards' },
      );
    }

    // Reduced motion: the stylesheet already shows the still frame for this
    // mood; the parts that changed fade to it over 200 ms.
    function crossFade(): void {
      const fade = { duration: CROSS_FADE_MS, easing: EASING.gentle };
      if (mood === 'happy') {
        play(part('lit'), [{ opacity: 0 }, { opacity: 1 }], fade);
        play(part('ray'), [{ opacity: 0 }, { opacity: BEAM_OPACITY }], fade);
        play(part('glow'), [{ opacity: 0.4 }, { opacity: 0.85 }], fade);
      } else if (mood === 'farewell') {
        play(part('arm'), [{ opacity: 1 }, { opacity: 0 }], fade);
        play(part('arm-rest'), [{ opacity: 0 }, { opacity: 1 }], fade);
      }
    }

    if (mq?.matches) {
      if (previous !== null && previous !== mood) crossFade();
    } else if (mood === 'happy') {
      happy();
    } else if (mood === 'farewell') {
      farewell();
    }

    function onMotionChange(event: MediaQueryListEvent): void {
      if (event.matches) cancelAll();
    }
    mq?.addEventListener('change', onMotionChange);

    return () => {
      cancelAll();
      mq?.removeEventListener('change', onMotionChange);
    };
  }, [svgRef, mood]);
}
