import React, { useRef, useEffect } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import type { ScreenShareConfig } from '../../stores/voiceStore';
import { buildScreenShareOptions } from '../../utils/screenShare';

const BITRATE_MIN = 500;   // kbps
const BITRATE_MAX = 20000; // kbps
const BITRATE_STEP = 500;  // kbps

interface ScreenShareSettingsPopoverProps {
  open: boolean;
  onClose: () => void;
}

const RESOLUTIONS: { value: ScreenShareConfig['height']; label: string }[] = [
  { value: 540, label: '540p' },
  { value: 720, label: '720p' },
  { value: 1080, label: '1080p' },
];

const FRAME_RATES: { value: ScreenShareConfig['fps']; label: string }[] = [
  { value: 30, label: '30' },
  { value: 45, label: '45' },
  { value: 60, label: '60' },
];

const MODES: { value: ScreenShareConfig['mode']; label: string }[] = [
  { value: 'gaming', label: 'Gaming' },
  { value: 'text', label: 'Text' },
];

function formatBitrate(bps: number): string {
  return `${(bps / 1_000_000).toFixed(bps % 1_000_000 === 0 ? 0 : 1)} Mbps`;
}

function formatDegradation(pref: RTCDegradationPreference): string {
  switch (pref) {
    case 'maintain-resolution': return 'hold resolution';
    case 'maintain-framerate': return 'hold framerate';
    case 'balanced': return 'balanced';
    default: return pref;
  }
}

function formatKbps(kbps: number): string {
  return kbps >= 1000
    ? `${(kbps / 1000).toFixed(kbps % 1000 === 0 ? 0 : 1)} Mbps`
    : `${kbps} kbps`;
}

export function ScreenShareSettingsPopover({ open, onClose }: ScreenShareSettingsPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const config = useVoiceStore((s) => s.screenShareConfig);
  const setConfig = useVoiceStore((s) => s.setScreenShareConfig);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, onClose]);

  if (!open) return null;

  const result = buildScreenShareOptions(config);

  const pillBase = 'px-3 py-1.5 rounded-full text-[13px] font-medium transition-colors cursor-pointer select-none';
  const pillSelected = 'bg-discord-blurple text-white';
  const pillUnselected = 'bg-[#2b2d31] text-discord-text-secondary hover:bg-[#35373c]';

  return (
    <div
      ref={popoverRef}
      className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 w-[260px] bg-[#1e1f22] rounded-lg shadow-lg border border-[#111214] z-50 overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-[#111214]">
        <span className="text-[14px] font-bold text-discord-text-primary">Stream Settings</span>
      </div>

      <div className="px-3 py-3 flex flex-col gap-3">
        {/* Resolution */}
        <div>
          <div className="text-[11px] text-discord-text-muted font-semibold uppercase tracking-wider mb-1.5">
            Resolution
          </div>
          <div className="flex gap-1.5">
            {RESOLUTIONS.map((r) => (
              <button
                key={r.value}
                onClick={() => setConfig({ height: r.value })}
                className={`${pillBase} ${config.height === r.value ? pillSelected : pillUnselected}`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* Frame Rate */}
        <div>
          <div className="text-[11px] text-discord-text-muted font-semibold uppercase tracking-wider mb-1.5">
            Frame Rate
          </div>
          <div className="flex gap-1.5">
            {FRAME_RATES.map((f) => (
              <button
                key={f.value}
                onClick={() => setConfig({ fps: f.value })}
                className={`${pillBase} ${config.fps === f.value ? pillSelected : pillUnselected}`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Content Mode */}
        <div>
          <div className="text-[11px] text-discord-text-muted font-semibold uppercase tracking-wider mb-1.5">
            Content Mode
          </div>
          <div className="flex gap-1.5">
            {MODES.map((m) => (
              <button
                key={m.value}
                onClick={() => setConfig({ mode: m.value })}
                className={`${pillBase} ${config.mode === m.value ? pillSelected : pillUnselected}`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* Bitrate Override */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[11px] text-discord-text-muted font-semibold uppercase tracking-wider">
              Bitrate
            </div>
            {config.customBitrateKbps != null && (
              <button
                onClick={() => setConfig({ customBitrateKbps: null })}
                className="text-[11px] text-discord-blurple hover:text-[#7983f5] font-medium transition-colors"
              >
                Reset to Auto
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={BITRATE_MIN}
              max={BITRATE_MAX}
              step={BITRATE_STEP}
              value={config.customBitrateKbps ?? Math.round(result.publish.videoEncoding.maxBitrate / 1000)}
              onChange={(e) => setConfig({ customBitrateKbps: Number(e.target.value) })}
              className="flex-1 h-1.5 accent-discord-blurple cursor-pointer appearance-none bg-[#4e5058] rounded-full
                [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
                [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md
                [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:border-0
                [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full
                [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:cursor-pointer"
            />
            <span className={`text-[12px] font-medium min-w-[64px] text-right ${
              config.customBitrateKbps != null ? 'text-discord-text-primary' : 'text-discord-text-muted'
            }`}>
              {config.customBitrateKbps != null
                ? formatKbps(config.customBitrateKbps)
                : `Auto`}
            </span>
          </div>
        </div>
      </div>

      {/* Footer — computed stats */}
      <div className="px-3 py-2 border-t border-[#111214]">
        <span className="text-[12px] text-discord-text-muted">
          {formatBitrate(result.publish.videoEncoding.maxBitrate)} · {formatDegradation(result.overdrive.degradationPreference)}
        </span>
      </div>
    </div>
  );
}
