import { useLayoutEffect, useRef } from 'react';
import { BREATH_PERIODS, Breath } from '../telemetry/scene/StarField';
import './AuthBackdrop.css';

export type AuthBackdropVariant = 'login' | 'register' | 'join' | 'invalid';

interface AuthBackdropProps {
  variant: AuthBackdropVariant;
}

/**
 * One near star. `x` and `y` are percentages of the frame, `r` the radius in
 * CSS pixels (so a star is one to two pixels wide on every screen, never
 * scaled with the frame), `tone` picks `star` or `dust` from the scene
 * palette, and `twinkle` marks the few that breathe.
 */
interface NearStar {
  x: number;
  y: number;
  r: number;
  tone: 'star' | 'dust';
  twinkle: boolean;
}

/**
 * Deterministic scatter, the same generator the telemetry hello scene uses,
 * so the sky is identical on every render and two screenshots differ only
 * by what changed on purpose.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scatter(seed: number, count: number): NearStar[] {
  const next = mulberry32(seed);
  const stars: NearStar[] = [];
  for (let i = 0; i < count; i += 1) {
    const x = 2 + next() * 96;
    const y = 2 + next() * 96;
    const r = 0.6 + next() * 0.5;
    stars.push({
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      r: Math.round(r * 100) / 100,
      tone: i % 5 === 3 ? 'dust' : 'star',
      twinkle: i % 3 === 0,
    });
  }
  return stars;
}

/** The near field: sparse, every one placed once, at most two pixels across. */
const NEAR_STARS: readonly NearStar[] = scatter(41, 26);

/**
 * What lies behind the card on every screen you reach before you are inside
 * the app: login, register, an invite, and an invite that has gone dark.
 * Owned by the UI soul pass (scene bible row 2, second pass).
 *
 * The scene is arriving: deep dark space, a large world low right and mostly
 * off-frame, and sparse crisp stars. The card in front is the airlock window.
 * Login, register and join share the scene as it is; an invite that has gone
 * dark gets it colder and dimmer.
 *
 * Placement: the component is the first child of the page's scrolling shell
 * (`relative h-full overflow-y-auto`). The root is a zero-height sticky box,
 * so it costs the page no layout and stays pinned to the top of the scroll
 * port while the card scrolls over it. The frame inside it is sized to the
 * scroll port by a ResizeObserver on the shell (with an `--app-vh` fallback
 * before the first measurement), which is what `position: fixed` would have
 * given us without escaping the design workbench's shells or painting under
 * the desktop title bar. Every sibling sits at `z-10`; the root stays at 0.
 */
export function AuthBackdrop({ variant }: AuthBackdropProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const frame = frameRef.current;
    const shell = root?.parentElement;
    if (!root || !frame || !shell) return undefined;
    const measure = () => {
      frame.style.setProperty('--scene-w', `${shell.clientWidth}px`);
      frame.style.setProperty('--scene-h', `${shell.clientHeight}px`);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={rootRef} className={`auth-backdrop auth-backdrop--${variant}`} aria-hidden="true">
      <div ref={frameRef} className="auth-backdrop__frame">
        <div className="auth-backdrop__void" />
        <div className="auth-backdrop__far" />
        <svg className="auth-backdrop__near" width="100%" height="100%" focusable="false">
          {NEAR_STARS.map((star, index) =>
            star.twinkle ? null : (
              <circle key={index} cx={`${star.x}%`} cy={`${star.y}%`} r={star.r} className={`auth-backdrop__star auth-backdrop__star--${star.tone}`} />
            ),
          )}
        </svg>
        <div className="auth-backdrop__breath">
          {NEAR_STARS.map((star, index) =>
            star.twinkle ? (
              <Breath
                key={index}
                left={`${star.x}%`}
                top={`${star.y}%`}
                size={star.r > 0.85 ? 2 : 1}
                period={BREATH_PERIODS[index % BREATH_PERIODS.length] ?? 5.75}
                phase={(index * 2.9) % 9}
                className={`auth-backdrop__star auth-backdrop__star--${star.tone}`}
              />
            ) : null,
          )}
        </div>
        <div className="auth-backdrop__world" />
      </div>
    </div>
  );
}
