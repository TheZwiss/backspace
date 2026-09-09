import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import './AuthBackdrop.css';

export type AuthBackdropVariant = 'login' | 'register' | 'join' | 'invalid';

interface AuthBackdropProps {
  variant: AuthBackdropVariant;
}

/**
 * One running light on the station's rim. `angle` is degrees from the crest
 * of the arc (negative is left, the side the key light comes from); the frame
 * shows roughly -22 to +22. `size` is the lamp's diameter in px. `kind` picks
 * the lamp: `run` is a warm running light, `cold` a sky standby light on an
 * instrument, `dim` a running light seen through more structure.
 */
interface Lamp {
  angle: number;
  size: number;
  kind: 'run' | 'cold' | 'dim';
}

/**
 * Hand-placed, in clusters, because an even repeat reads as a barcode and a
 * built thing has its lights where the docking bays, the airlocks and the
 * antennae are. Two pairs (-19.5/-18.6 and 6.4/7.6) read as the two lamps a
 * bay door carries.
 */
const LAMPS: readonly Lamp[] = [
  { angle: -21.2, size: 3, kind: 'dim' },
  { angle: -19.5, size: 3.5, kind: 'run' },
  { angle: -18.6, size: 2.5, kind: 'run' },
  { angle: -12.4, size: 3, kind: 'run' },
  { angle: -10.9, size: 2, kind: 'cold' },
  { angle: -5.3, size: 3.5, kind: 'run' },
  { angle: -1.6, size: 2.5, kind: 'dim' },
  { angle: 1.9, size: 3, kind: 'run' },
  { angle: 6.4, size: 3, kind: 'run' },
  { angle: 7.6, size: 3, kind: 'run' },
  { angle: 11.8, size: 2, kind: 'cold' },
  { angle: 17.3, size: 3.5, kind: 'run' },
  { angle: 21.4, size: 2.5, kind: 'dim' },
];

/** Windows in the hull below the rim: the station's own cabin light, dimmer than any lamp. */
const PORTS: readonly { angle: number; depth: number; width: number }[] = [
  { angle: -16.8, depth: 1.6, width: 5 },
  { angle: -15.9, depth: 1.6, width: 3 },
  { angle: -8.1, depth: 2.3, width: 4 },
  { angle: -3.4, depth: 1.5, width: 6 },
  { angle: 4.2, depth: 2.6, width: 3 },
  { angle: 9.9, depth: 1.7, width: 5 },
  { angle: 14.6, depth: 2.4, width: 4 },
  { angle: 19.8, depth: 1.5, width: 3 },
];

/** The skyline above the rim: antenna masts and one gantry, silhouettes with the key down one side. */
const STRUCTURES: readonly { angle: number; height: number; kind: 'mast' | 'gantry' }[] = [
  { angle: -7.3, height: 11, kind: 'mast' },
  { angle: 9.7, height: 14, kind: 'gantry' },
  { angle: 19.1, height: 8, kind: 'mast' },
];

/** The beacon you followed sits on a mast at this angle; the berth being prepared is at this one. */
const BEACON_ANGLE = -14;
const BERTH_ANGLE = 15.4;

/**
 * A point on the rim of the station, as percentages of the station's own
 * square box. The station is a circle whose width is a fixed multiple of the
 * frame's width, so a given angle always lands at the same fraction of the
 * frame's width, and the lamps keep their spacing from a phone to a 2560 wide
 * monitor. `depth` is how far inside the rim, in percent of the radius.
 */
function onRim(angle: number, depth = 0): CSSProperties {
  const rad = (angle * Math.PI) / 180;
  const r = 50 - depth / 2;
  return {
    left: `${(50 + r * Math.sin(rad)).toFixed(3)}%`,
    top: `${(50 - r * Math.cos(rad)).toFixed(3)}%`,
  };
}

/**
 * What lies behind the card on every screen you reach before you are inside
 * the app: login, register, an invite, and an invite that has gone dark.
 * Owned by the UI soul pass (scene bible row 2).
 *
 * The scene is docking: the last minute of a slow approach to a station,
 * seen from the craft arriving. The card in front is the airlock window.
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
        <div className="auth-backdrop__stars auth-backdrop__stars--far" />
        <div className="auth-backdrop__stars auth-backdrop__stars--near" />
        <div className="auth-backdrop__world" />
        <div className="auth-backdrop__approach">
          <div className="auth-backdrop__station">
            {PORTS.map((port) => (
              <span
                key={port.angle}
                className="auth-backdrop__port"
                style={{ ...onRim(port.angle, port.depth), width: port.width }}
              />
            ))}
            {LAMPS.map((lamp) => (
              <span
                key={lamp.angle}
                className={`auth-backdrop__lamp auth-backdrop__lamp--${lamp.kind}`}
                style={{ ...onRim(lamp.angle), width: lamp.size, height: lamp.size }}
              />
            ))}
            {STRUCTURES.map((item) => (
              <span
                key={item.angle}
                className={`auth-backdrop__struct auth-backdrop__struct--${item.kind}`}
                style={{ ...onRim(item.angle), '--struct-h': `${item.height}px` } as CSSProperties}
              />
            ))}
            <span className="auth-backdrop__mast" style={onRim(BEACON_ANGLE)}>
              <span className="auth-backdrop__beacon" />
            </span>
            <span className="auth-backdrop__berth" style={onRim(BERTH_ANGLE)} />
          </div>
        </div>
        <div className="auth-backdrop__dust" />
        <div className="auth-backdrop__scrim" />
      </div>
    </div>
  );
}
