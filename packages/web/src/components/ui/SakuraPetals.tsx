import type { CSSProperties, JSX } from 'react';
import { useThemeStore } from '../../stores/themeStore';

interface Petal {
  left: number;
  size: number;
  duration: number;
  delay: number;
  drift: number;
  spin: number;
}

/** Fixed, hand-tuned spread so the render is deterministic and the field looks even. */
const PETALS: readonly Petal[] = [
  { left: 4, size: 11, duration: 19, delay: 0, drift: 60, spin: 420 },
  { left: 13, size: 15, duration: 24, delay: 6, drift: -50, spin: -360 },
  { left: 22, size: 10, duration: 21, delay: 12, drift: 80, spin: 540 },
  { left: 31, size: 13, duration: 26, delay: 3, drift: -70, spin: -480 },
  { left: 40, size: 16, duration: 23, delay: 9, drift: 40, spin: 360 },
  { left: 49, size: 10, duration: 20, delay: 15, drift: -90, spin: -420 },
  { left: 58, size: 14, duration: 27, delay: 1, drift: 70, spin: 480 },
  { left: 67, size: 12, duration: 22, delay: 8, drift: -40, spin: -540 },
  { left: 76, size: 15, duration: 25, delay: 13, drift: 90, spin: 400 },
  { left: 85, size: 11, duration: 21, delay: 4, drift: -60, spin: -380 },
  { left: 93, size: 13, duration: 24, delay: 10, drift: 50, spin: 460 },
];

/**
 * Ambient falling cherry petals for the Anime theme. Purely decorative: it
 * never takes pointer events, sits under modals and menus, and is hidden by
 * `prefers-reduced-motion` in globals.css.
 */
export function SakuraPetals(): JSX.Element | null {
  const active = useThemeStore(state => state.theme === 'anime');
  if (!active) return null;
  return (
    <div aria-hidden="true" data-anime="petals" className="sakura-petals">
      {PETALS.map(petal => (
        <span key={petal.left} className="sakura-petal" style={{
          left: `${petal.left}%`,
          width: petal.size,
          height: petal.size,
          animationDuration: `${petal.duration}s`,
          animationDelay: `-${petal.delay}s`,
          '--petal-drift': `${petal.drift}px`,
          '--petal-spin': `${petal.spin}deg`,
        } as CSSProperties} />
      ))}
    </div>
  );
}
