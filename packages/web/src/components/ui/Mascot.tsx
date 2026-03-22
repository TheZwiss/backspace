import { useId, useRef } from 'react';
import { useMascotAnimation } from '../../hooks/useMascotAnimation';

export const MASCOT_PALETTES = {
  idle:     { from: '#c8f0de', to: '#6dbf96', shadow: 'rgba(168,216,192,0.13)', blush: '#f5a8a8' },
  sleeping: { from: '#ddd4f0', to: '#a898cc', shadow: 'rgba(180,160,210,0.1)',  blush: '#d8a0c0' },
  excited:  { from: '#fde0c8', to: '#e8a870', shadow: 'rgba(240,176,128,0.13)', blush: '#f5a8a8' },
  lonely:   { from: '#c0dced', to: '#78aec8', shadow: 'rgba(120,174,200,0.1)',  blush: '#a0a0b8' },
} as const;

export type MascotState = keyof typeof MASCOT_PALETTES;

interface MascotProps {
  state: MascotState;
  className?: string;
}

interface SvgProps {
  palette: (typeof MASCOT_PALETTES)[MascotState];
  gradientId: string;
  svgRef: React.RefObject<SVGSVGElement | null>;
}

function IdleSvg({ palette, gradientId, svgRef }: SvgProps) {
  return (
    <svg ref={svgRef} viewBox="0 0 200 200" aria-hidden="true" width="100%" height="100%">
      <defs>
        <radialGradient id={gradientId} cx="38%" cy="30%" r="65%">
          <stop offset="0%" stopColor={palette.from} />
          <stop offset="100%" stopColor={palette.to} />
        </radialGradient>
      </defs>

      {/* Shadow */}
      <ellipse data-mascot="shadow" cx="100" cy="188" rx="32" ry="6" fill={palette.shadow} />

      {/* Body */}
      <path
        data-mascot="body"
        d="M100 28 C132 24, 162 48, 166 84 C170 120, 152 154, 122 162 C108 166, 92 166, 78 162 C48 154, 30 120, 34 84 C38 48, 68 24, 100 28Z"
        fill={`url(#${gradientId})`}
      />

      {/* Inner highlight */}
      <ellipse cx="84" cy="58" rx="26" ry="14" fill="rgba(255,255,255,0.13)" transform="rotate(-18 84 58)" />

      {/* Left eye */}
      <ellipse data-eye="white" data-side="left" cx="80" cy="92" rx="12" ry="13" fill="#1a1a23" />
      <ellipse data-eye="pupil" data-side="left" cx="81" cy="93" rx="7.5" ry="8" fill="#0d0d12" />
      <circle cx="85" cy="87" r="3.2" fill="rgba(255,255,255,0.88)" />
      <circle cx="78" cy="96" r="1.2" fill="rgba(255,255,255,0.4)" />

      {/* Right eye */}
      <ellipse data-eye="white" data-side="right" cx="120" cy="92" rx="12" ry="13" fill="#1a1a23" />
      <ellipse data-eye="pupil" data-side="right" cx="121" cy="93" rx="7.5" ry="8" fill="#0d0d12" />
      <circle cx="125" cy="87" r="3.2" fill="rgba(255,255,255,0.88)" />
      <circle cx="118" cy="96" r="1.2" fill="rgba(255,255,255,0.4)" />

      {/* Blush */}
      <ellipse cx="64" cy="108" rx="8" ry="3.5" fill={palette.blush} opacity="0.28" transform="rotate(-8 64 108)" />
      <ellipse cx="136" cy="108" rx="8" ry="3.5" fill={palette.blush} opacity="0.28" transform="rotate(8 136 108)" />

      {/* Mouth */}
      <path
        data-mascot="mouth"
        d="M92 116 Q100 123, 108 116"
        stroke="#1a1a23"
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SleepingSvg({ palette, gradientId, svgRef }: SvgProps) {
  return (
    <svg ref={svgRef} viewBox="0 0 220 130" aria-hidden="true" width="100%" height="100%">
      <defs>
        <radialGradient id={gradientId} cx="40%" cy="30%" r="65%">
          <stop offset="0%" stopColor={palette.from} />
          <stop offset="100%" stopColor={palette.to} />
        </radialGradient>
      </defs>

      {/* Shadow */}
      <ellipse data-mascot="shadow" cx="110" cy="120" rx="50" ry="5" fill={palette.shadow} />

      {/* Body */}
      <path
        data-mascot="body"
        d="M110 24 C152 20, 190 38, 192 64 C194 86, 174 106, 142 112 C126 116, 94 116, 78 112 C46 106, 26 86, 28 64 C30 38, 68 20, 110 24Z"
        fill={`url(#${gradientId})`}
      />

      {/* Inner highlight */}
      <ellipse cx="96" cy="44" rx="30" ry="12" fill="rgba(255,255,255,0.08)" transform="rotate(-8 96 44)" />

      {/* Left closed eye */}
      <path
        data-eye="closed"
        data-side="left"
        d="M86 64 Q94 54, 102 64"
        stroke="#2a2a36"
        strokeWidth="2.8"
        fill="none"
        strokeLinecap="round"
      />

      {/* Right closed eye */}
      <path
        data-eye="closed"
        data-side="right"
        d="M118 64 Q126 54, 134 64"
        stroke="#2a2a36"
        strokeWidth="2.8"
        fill="none"
        strokeLinecap="round"
      />

      {/* Blush */}
      <ellipse cx="78" cy="76" rx="8" ry="3" fill={palette.blush} opacity="0.22" />
      <ellipse cx="142" cy="76" rx="8" ry="3" fill={palette.blush} opacity="0.22" />

      {/* Mouth */}
      <ellipse data-mascot="mouth" cx="110" cy="78" rx="4" ry="3.2" fill="#2a2a36" opacity="0.3" />
    </svg>
  );
}

function ExcitedSvg({ palette, gradientId, svgRef }: SvgProps) {
  return (
    <svg ref={svgRef} viewBox="0 0 200 200" aria-hidden="true" width="100%" height="100%">
      <defs>
        <radialGradient id={gradientId} cx="36%" cy="30%" r="65%">
          <stop offset="0%" stopColor={palette.from} />
          <stop offset="100%" stopColor={palette.to} />
        </radialGradient>
      </defs>

      {/* Shadow */}
      <ellipse data-mascot="shadow" cx="100" cy="188" rx="32" ry="6" fill={palette.shadow} />

      {/* Body */}
      <path
        data-mascot="body"
        d="M100 28 C132 24, 162 48, 166 84 C170 120, 152 154, 122 162 C108 166, 92 166, 78 162 C48 154, 30 120, 34 84 C38 48, 68 24, 100 28Z"
        fill={`url(#${gradientId})`}
      />

      {/* Inner highlight */}
      <ellipse cx="84" cy="58" rx="24" ry="13" fill="rgba(255,255,255,0.12)" transform="rotate(-15 84 58)" />

      {/* Left eye */}
      <ellipse data-eye="white" data-side="left" cx="80" cy="92" rx="12" ry="13" fill="#1a1a23" />
      <ellipse data-eye="pupil" data-side="left" cx="81" cy="93" rx="7.5" ry="8" fill="#0d0d12" />
      <circle cx="85" cy="87" r="3.2" fill="rgba(255,255,255,0.88)" />
      <circle cx="78" cy="96" r="1.2" fill="rgba(255,255,255,0.4)" />

      {/* Right eye */}
      <ellipse data-eye="white" data-side="right" cx="120" cy="92" rx="12" ry="13" fill="#1a1a23" />
      <ellipse data-eye="pupil" data-side="right" cx="121" cy="93" rx="7.5" ry="8" fill="#0d0d12" />
      <circle cx="125" cy="87" r="3.2" fill="rgba(255,255,255,0.88)" />
      <circle cx="118" cy="96" r="1.2" fill="rgba(255,255,255,0.4)" />

      {/* Blush */}
      <ellipse cx="64" cy="108" rx="8" ry="3.5" fill={palette.blush} opacity="0.3" transform="rotate(-8 64 108)" />
      <ellipse cx="136" cy="108" rx="8" ry="3.5" fill={palette.blush} opacity="0.3" transform="rotate(8 136 108)" />

      {/* Mouth — wider smile */}
      <path
        data-mascot="mouth"
        d="M92 116 Q100 128, 108 116"
        stroke="#1a1a23"
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

function LonelySvg({ palette, gradientId, svgRef }: SvgProps) {
  return (
    <svg ref={svgRef} viewBox="0 0 200 200" aria-hidden="true" width="100%" height="100%">
      <defs>
        <radialGradient id={gradientId} cx="40%" cy="30%" r="65%">
          <stop offset="0%" stopColor={palette.from} />
          <stop offset="100%" stopColor={palette.to} />
        </radialGradient>
      </defs>

      {/* Shadow — smaller */}
      <ellipse data-mascot="shadow" cx="100" cy="188" rx="28" ry="5" fill={palette.shadow} />

      {/* Body — different from idle */}
      <path
        data-mascot="body"
        d="M100 32 C130 28, 158 50, 160 86 C162 118, 146 150, 120 158 C108 162, 92 162, 80 158 C54 150, 38 118, 40 86 C42 50, 70 28, 100 32Z"
        fill={`url(#${gradientId})`}
      />

      {/* Inner highlight */}
      <ellipse cx="84" cy="60" rx="22" ry="12" fill="rgba(255,255,255,0.07)" transform="rotate(-15 84 60)" />

      {/* Left eye — larger, sadder */}
      <ellipse data-eye="white" data-side="left" cx="80" cy="96" rx="13" ry="14" fill="#1a1a23" />
      <ellipse data-eye="pupil" data-side="left" cx="79" cy="100" rx="8" ry="8.5" fill="#0d0d12" />
      <circle cx="83" cy="92" r="2.8" fill="rgba(255,255,255,0.6)" />

      {/* Right eye — larger, sadder */}
      <ellipse data-eye="white" data-side="right" cx="120" cy="96" rx="13" ry="14" fill="#1a1a23" />
      <ellipse data-eye="pupil" data-side="right" cx="119" cy="100" rx="8" ry="8.5" fill="#0d0d12" />
      <circle cx="123" cy="92" r="2.8" fill="rgba(255,255,255,0.6)" />

      {/* Blush — dimmer */}
      <ellipse cx="64" cy="112" rx="7" ry="3" fill={palette.blush} opacity="0.18" />
      <ellipse cx="136" cy="112" rx="7" ry="3" fill={palette.blush} opacity="0.18" />

      {/* Mouth — frown */}
      <path
        data-mascot="mouth"
        d="M92 122 Q100 117, 108 122"
        stroke="#1a1a23"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        opacity="0.5"
      />
    </svg>
  );
}

export function Mascot({ state, className }: MascotProps) {
  const uid = useId();
  const gradientId = `mascot-grad-${uid.replace(/:/g, '')}`;
  const palette = MASCOT_PALETTES[state];
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useMascotAnimation(svgRef, containerRef, state);

  const classes = className ? `w-32 h-32 ${className}` : 'w-32 h-32';

  return (
    <div ref={containerRef} role="presentation" className={classes} style={{ position: 'relative' }}>
      {state === 'idle' && <IdleSvg palette={palette} gradientId={gradientId} svgRef={svgRef} />}
      {state === 'sleeping' && <SleepingSvg palette={palette} gradientId={gradientId} svgRef={svgRef} />}
      {state === 'excited' && <ExcitedSvg palette={palette} gradientId={gradientId} svgRef={svgRef} />}
      {state === 'lonely' && <LonelySvg palette={palette} gradientId={gradientId} svgRef={svgRef} />}
      {state === 'sleeping' && (
        <div
          data-mascot="z-container"
          style={{
            position: 'absolute',
            top: '-15px',
            right: '8px',
            width: '50px',
            height: '90px',
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  );
}
