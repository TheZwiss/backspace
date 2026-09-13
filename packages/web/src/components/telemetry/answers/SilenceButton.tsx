import type { ReactNode } from 'react';
import './SilenceButton.css';

interface SilenceButtonProps {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * The "no" answer in the telemetry ask: a derelict hull plate, adrift.
 *
 * The modal's scene is a live little rocket over a starfield. This is the far
 * side of that world — a panel that used to transmit, tumbling slowly in
 * vacuum, oxidised and frosted, carrying a signal that flatlined a long time
 * ago. The outboard end is torn away: the silhouette itself is broken by a mask
 * in the stylesheet, and the SVG below only draws the starlight caught on that
 * ragged edge. Every layer is described in SilenceButton.css.
 */
export function SilenceButton({ children, disabled = false, onClick }: SilenceButtonProps) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className="silence-button">
      {/* Drift: the slow tumble, and the shadow the torn shape casts. */}
      <span className="silence-button__drift">
        {/* Plate: the hull. Masked to the torn silhouette; clips its own materials. */}
        <span className="silence-button__plate">
          <span className="silence-button__oxide" aria-hidden="true" />
          <span className="silence-button__rime" aria-hidden="true" />
          <span className="silence-button__grain" aria-hidden="true" />
          <span className="silence-button__array" aria-hidden="true" />

          {/* Carrier: the transmitter's flat line. */}
          <span className="silence-button__carrier" aria-hidden="true" />

          {/* Blip: the last thing it said, decaying into that line. */}
          <svg className="silence-button__blip" viewBox="0 0 46 14" aria-hidden="true" focusable="false">
            <defs>
              <linearGradient id="silence-blip-fade" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="rgb(199 210 254)" stopOpacity="0.5" />
                <stop offset="0.55" stopColor="rgb(160 170 205)" stopOpacity="0.22" />
                <stop offset="1" stopColor="rgb(160 170 205)" stopOpacity="0.05" />
              </linearGradient>
            </defs>
            <path
              d="M0 7 H5 L6.5 6.2 L8 1.5 L9.6 12.4 L11.2 3.8 L12.8 9.8 L14.4 5.6 L16 8.6 L17.6 6.4 L19.2 7.5 L20.8 6.9 L22.4 7.2 H46"
              fill="none"
              stroke="url(#silence-blip-fade)"
              strokeWidth="1"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          {/* Ping: one pulse leaves, crosses, and dies before the far edge. */}
          <span className="silence-button__ping" aria-hidden="true" />

          {/* Motes: dust the wreck carries, moving at vacuum speed. */}
          <span className="silence-button__motes" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>

          <span className="silence-button__label">{children}</span>

          {/* Torn edge: starlight on the fracture. The break itself is a mask;
              this only lights the facets that happen to face the stars. */}
          <svg
            className="silence-button__tear"
            viewBox="0 0 22 42"
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            {/* the edge core: the sheet has thickness, so the break has a dark side */}
            <path
              d="M12 -1 L5 6 L13 10.5 L2.5 17 L10.5 22 L4 28 L12.5 32 L2 38.5 L7 43"
              fill="none"
              stroke="rgb(0 0 0)"
              strokeOpacity="0.55"
              strokeWidth="2.5"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            {/* the whole break, faintly */}
            <path
              d="M12 -1 L5 6 L13 10.5 L2.5 17 L10.5 22 L4 28 L12.5 32 L2 38.5 L7 43"
              fill="none"
              stroke="rgb(199 210 254)"
              strokeOpacity="0.1"
              strokeWidth="1"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            {/* and the facets that happen to face the stars */}
            <path
              d="M5 6 L13 10.5 M2.5 17 L10.5 22 M4 28 L12.5 32 M2 38.5 L7 43"
              fill="none"
              stroke="rgb(199 210 254)"
              strokeOpacity="0.32"
              strokeWidth="1"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </span>

        {/* Debris: fragments that left the hull and never went anywhere. They
            sit outboard of the break, in the gap before the live answer. */}
        <span className="silence-button__debris" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </span>
    </button>
  );
}
