import { useEffect, useRef } from 'react';
import type { SceneMood } from './HelloScene';
import { ARM_REST_DEG } from './Pilot';

const EASING = {
  gentle: 'cubic-bezier(0.4, 0, 0.2, 1)',
  softOut: 'cubic-bezier(0, 0, 0.2, 1)',
} as const;

const CROSS_FADE_MS = 200;
const BEAM_OPACITY = 0.6;
// Slower than the 900 ms arrival: light withdrawing reads as deliberate, light
// arriving reads as eager. The cabin settles a little after the beam is home.
const RETRACT_MS = 620;
const SETTLE_MS = 680;

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
        { duration: 1500, easing: EASING.gentle, fill: 'forwards' },
      );
    }

    /**
     * The way back out of `happy`. The modal never needed one: it is answered
     * once and closed, so the beam only ever arrives. A settings panel
     * switches the hello off as often as on, and that is the transition an
     * admin actually watches, so the light is drawn back into the porthole
     * rather than cut.
     *
     * Nothing here fills forwards, and nothing needs to: every track ends on
     * the value the stylesheet already holds for a scene that is not happy, so
     * each element is handed back exactly where CSS picks it up.
     *
     * The cabin holds its brightness through the first third rather than
     * taking a `delay`. A delayed track sits at its underlying value until it
     * starts, and that value is the dark one, so a delay would blink the
     * window off and on again before dimming it.
     */
    function retract(): void {
      play(
        part('ray'),
        [
          { transform: 'scaleX(1)', opacity: BEAM_OPACITY },
          { opacity: BEAM_OPACITY, offset: 0.45 },
          { transform: 'scaleX(0)', opacity: 0 },
        ],
        { duration: RETRACT_MS, easing: EASING.gentle },
      );
      play(
        part('lit'),
        [
          { opacity: 1, offset: 0 },
          { opacity: 1, offset: 0.38 },
          { opacity: 0, offset: 1 },
        ],
        { duration: SETTLE_MS, easing: EASING.gentle },
      );
      play(
        part('glow'),
        [
          { opacity: 0.85, transform: 'scale(1.2)', offset: 0 },
          { opacity: 0.85, transform: 'scale(1.2)', offset: 0.38 },
          { opacity: 0.4, transform: 'scale(1)', offset: 1 },
        ],
        { duration: SETTLE_MS, easing: EASING.gentle },
      );
    }

    // Reduced motion: the stylesheet already shows the still frame for this
    // mood; the parts that changed fade to it over 200 ms.
    function crossFade(leavingHappy: boolean): void {
      const fade = { duration: CROSS_FADE_MS, easing: EASING.gentle };
      if (leavingHappy) {
        // The beam's width is pinned across both frames. The still frame for
        // any scene that is not happy puts the ray at scaleX(0), so letting
        // the transform track its own way there would collapse the beam to
        // nothing in the first frame and leave the opacity nothing to fade.
        play(
          part('ray'),
          [
            { transform: 'scaleX(1)', opacity: BEAM_OPACITY },
            { transform: 'scaleX(1)', opacity: 0 },
          ],
          fade,
        );
        play(part('lit'), [{ opacity: 1 }, { opacity: 0 }], fade);
        play(part('glow'), [{ opacity: 0.85 }, { opacity: 0.4 }], fade);
      }
      if (mood === 'happy') {
        play(part('lit'), [{ opacity: 0 }, { opacity: 1 }], fade);
        play(part('ray'), [{ opacity: 0 }, { opacity: BEAM_OPACITY }], fade);
        play(part('glow'), [{ opacity: 0.4 }, { opacity: 0.85 }], fade);
      } else if (mood === 'farewell') {
        play(part('arm'), [{ opacity: 1 }, { opacity: 0 }], fade);
        play(part('arm-rest'), [{ opacity: 0 }, { opacity: 1 }], fade);
      }
    }

    // Leaving `happy` is its own step rather than an alternative to the new
    // mood's choreography: switching the hello off plays the beam home AND
    // lowers the pilot's arm, and the two touch different parts of the scene.
    const leavingHappy = previous === 'happy' && mood !== 'happy';

    if (mq?.matches) {
      if (previous !== null && previous !== mood) crossFade(leavingHappy);
    } else {
      if (leavingHappy) retract();
      if (mood === 'happy') happy();
      else if (mood === 'farewell') farewell();
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
