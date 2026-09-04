import React, { useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useVoiceStore } from '../../stores/voiceStore';
import type { ScreenShareConfig } from '../../stores/voiceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { buildScreenShareOptions } from '../../utils/screenShare';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';
import { usePortalContainer } from '../../hooks/usePortalContainer';
import { Toggle } from '../ui/Toggle';
import { isElectron } from '../../platform/platform';
import { RESOLUTION_LABELS } from '@backspace/shared/src/constants';
import i18n from '../../i18n';
import { formatters } from '../../i18n/formatters';

interface ScreenShareSettingsPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

const MODES: { value: ScreenShareConfig['mode']; labelKey: 'voice:streamSettings.mode.gaming' | 'voice:streamSettings.mode.text' }[] = [
  { value: 'gaming', labelKey: 'voice:streamSettings.mode.gaming' },
  { value: 'text', labelKey: 'voice:streamSettings.mode.text' },
];

const CODEC_OPTIONS = [
  { value: 'vp9' as const, labelKey: 'voice:streamSettings.codecOption.standard' as const, sub: 'VP9' },
  { value: 'hw' as const, labelKey: 'voice:streamSettings.codecOption.hardware' as const, sub: 'H.264' },
];

/** Whole Mbps when the value is round, otherwise one decimal; the number goes through the locale. */
function formatBitrate(bps: number): string {
  const mbps = bps % 1_000_000 === 0 ? bps / 1_000_000 : Math.round(bps / 100_000) / 10;
  return i18n.t('common:units.mbps', { value: formatters.formatNumber(mbps) });
}

function formatDegradation(pref: RTCDegradationPreference): string {
  switch (pref) {
    case 'maintain-resolution': return i18n.t('voice:streamSettings.degradation.maintainResolution');
    case 'maintain-framerate': return i18n.t('voice:streamSettings.degradation.maintainFramerate');
    case 'balanced': return i18n.t('voice:streamSettings.degradation.balanced');
    default: return pref;
  }
}

function formatKbps(kbps: number): string {
  if (kbps >= 1000) {
    const mbps = kbps % 1000 === 0 ? kbps / 1000 : Math.round(kbps / 100) / 10;
    return i18n.t('common:units.mbps', { value: formatters.formatNumber(mbps) });
  }
  return i18n.t('common:units.kbps', { value: formatters.formatNumber(kbps) });
}

export function ScreenShareSettingsPopover({ open, onClose, anchorRef }: ScreenShareSettingsPopoverProps) {
  const { t } = useTranslation(['voice', 'common']);
  const popoverRef = useRef<HTMLDivElement>(null);
  const portalContainer = usePortalContainer();
  const config = useVoiceStore((s) => s.screenShareConfig);
  const setConfig = useVoiceStore((s) => s.setScreenShareConfig);
  const hwOverdrive = useVoiceStore((s) => s.hwOverdrive);
  const setHwOverdrive = useVoiceStore((s) => s.setHwOverdrive);
  const limits = useSettingsStore((s) => s.streamingLimits);

  const { style } = useFloatingPosition(anchorRef, popoverRef, {
    placement: 'top',
    offset: 12,
    enabled: open,
  });

  const BITRATE_MIN = limits?.minBitrateKbps ?? 500;
  const BITRATE_MAX = limits?.maxBitrateKbps ?? 20000;
  const BITRATE_STEP = limits?.bitrateStepKbps ?? 500;

  const RESOLUTIONS = (limits?.allowedResolutions ?? [540, 720, 1080]).map((r) => ({
    value: r as ScreenShareConfig['height'],
    label: RESOLUTION_LABELS[r as keyof typeof RESOLUTION_LABELS] ?? `${r}p`,
  }));
  const FRAME_RATES = (limits?.allowedFramerates ?? [30, 45, 60]).map((f) => ({
    value: f as ScreenShareConfig['fps'],
    label: `${f}`,
  }));

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

  // Auto-clamp persisted config if outside allowed bounds
  useEffect(() => {
    if (!limits) return;
    const patch: Partial<ScreenShareConfig> = {};
    if (!limits.allowedResolutions.includes(config.height)) {
      const numericRes = limits.allowedResolutions.filter((r): r is number => r !== 'native');
      if (typeof config.height === 'number' && numericRes.length > 0) {
        const h = config.height;
        patch.height = numericRes.reduce((a, b) =>
          Math.abs(b - h) < Math.abs(a - h) ? b : a
        );
      } else {
        // 'native' was disabled or no numeric options — fall back to highest numeric
        patch.height = numericRes.length > 0 ? Math.max(...numericRes) : 1080;
      }
    }
    if (!limits.allowedFramerates.includes(config.fps)) {
      const f = config.fps;
      const closest = limits.allowedFramerates.reduce((a, b) =>
        Math.abs(b - f) < Math.abs(a - f) ? b : a
      );
      patch.fps = closest;
    }
    if (config.customBitrateKbps != null) {
      const clamped = Math.min(Math.max(config.customBitrateKbps, limits.minBitrateKbps), limits.maxBitrateKbps);
      if (clamped !== config.customBitrateKbps) patch.customBitrateKbps = clamped;
    }
    if (Object.keys(patch).length > 0) setConfig(patch);
  }, [limits, config, setConfig]);

  if (!open) return null;

  const result = buildScreenShareOptions(config);

  const pillBase = 'px-2.5 py-1.5 rounded-full text-[13px] font-medium transition-colors cursor-pointer select-none text-center';
  const pillSelected = 'bg-accent-primary text-white';
  const pillUnselected = 'bg-surface-elevated text-txt-secondary hover:bg-interactive-hover';

  return createPortal(
    <div
      ref={popoverRef}
      style={style}
      className="w-[260px] glass rounded-lg overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-border-hard">
        <span className="text-[14px] font-bold text-txt-primary">{t('voice:streamSettings.title')}</span>
      </div>

      <div className="px-3 py-3 flex flex-col gap-3">
        {/* Resolution */}
        <div>
          <div className="text-[11px] text-txt-tertiary font-semibold uppercase tracking-wider mb-1.5">
            {t('voice:streamSettings.resolution')}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {RESOLUTIONS.map((r) => (
              <button
                key={String(r.value)}
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
          <div className="text-[11px] text-txt-tertiary font-semibold uppercase tracking-wider mb-1.5">
            {t('voice:streamSettings.frameRate')}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
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
          <div className="text-[11px] text-txt-tertiary font-semibold uppercase tracking-wider mb-1.5">
            {t('voice:streamSettings.contentMode')}
          </div>
          <div className="flex gap-1.5">
            {MODES.map((m) => (
              <button
                key={m.value}
                onClick={() => setConfig({ mode: m.value })}
                className={`${pillBase} ${config.mode === m.value ? pillSelected : pillUnselected}`}
              >
                {t(m.labelKey)}
              </button>
            ))}
          </div>
        </div>

        {/* Codec */}
        <div>
          <div className="text-[11px] text-txt-tertiary font-semibold uppercase tracking-wider mb-1.5">
            {t('voice:streamSettings.codec')}
          </div>
          <div className="flex gap-1.5">
            {CODEC_OPTIONS.map((c) => {
              const isHw = c.value === 'hw';
              const isSelected = isHw ? hwOverdrive : !hwOverdrive;
              return (
                <button
                  key={c.value}
                  onClick={() => setHwOverdrive(isHw)}
                  className={`${pillBase} flex flex-col items-center gap-0 leading-tight ${
                    isSelected
                      ? (isHw ? 'bg-accent-amber/60 text-white' : pillSelected)
                      : (isHw ? 'bg-surface-elevated/50 text-txt-tertiary hover:bg-interactive-hover' : pillUnselected)
                  }`}
                >
                  <span>{t(c.labelKey)}</span>
                  <span className="text-[10px] opacity-60">{c.sub}</span>
                </button>
              );
            })}
          </div>
          {hwOverdrive && (
            <div className="text-[10px] text-accent-amber/80 mt-1">
              {t('voice:streamSettings.hardwareNote')}
            </div>
          )}
        </div>

        {/* Bitrate */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[11px] text-txt-tertiary font-semibold uppercase tracking-wider">
              {t('voice:streamSettings.bitrate')}
            </div>
            {limits?.allowCustomBitrate !== false && config.customBitrateKbps != null && (
              <button
                onClick={() => setConfig({ customBitrateKbps: null })}
                className="text-[11px] text-accent-primary hover:text-accent-lavender font-medium transition-colors"
              >
                {t('voice:streamSettings.resetToAuto')}
              </button>
            )}
          </div>
          {limits?.allowCustomBitrate !== false ? (
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={BITRATE_MIN}
                max={BITRATE_MAX}
                step={BITRATE_STEP}
                value={config.customBitrateKbps ?? Math.round(result.publish.videoEncoding.maxBitrate / 1000)}
                onChange={(e) => setConfig({ customBitrateKbps: Number(e.target.value) })}
                className="flex-1 h-1.5 accent-accent-primary cursor-pointer appearance-none bg-interactive-muted rounded-full
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
                  [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md
                  [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:border-0
                  [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full
                  [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:cursor-pointer"
              />
              <span className={`text-[12px] font-medium min-w-[64px] text-right ${
                config.customBitrateKbps != null ? 'text-txt-primary' : 'text-txt-tertiary'
              }`}>
                {config.customBitrateKbps != null
                  ? formatKbps(config.customBitrateKbps)
                  : t('voice:streamSettings.auto')}
              </span>
            </div>
          ) : (
            <div>
              <div className="text-[12px] text-txt-secondary font-medium">
                {formatKbps(Math.round(result.publish.videoEncoding.maxBitrate / 1000))}
              </div>
              <div className="text-[10px] text-txt-tertiary mt-0.5">
                {t('voice:streamSettings.customBitrateDisabled')}
              </div>
            </div>
          )}
        </div>

        {/* System Audio */}
        <div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[11px] text-txt-tertiary font-semibold uppercase tracking-wider">
                {t('voice:streamSettings.systemAudio')}
              </div>
              {isElectron() && config.shareAudio && (
                <div className="text-[10px] text-accent-amber/80 mt-0.5">
                  {t('voice:streamSettings.chromeEchoNote')}
                </div>
              )}
            </div>
            <Toggle
              enabled={config.shareAudio}
              onChange={(enabled) => setConfig({ shareAudio: enabled })}
            />
          </div>
        </div>
      </div>

      {/* Footer — computed stats */}
      <div className="px-3 py-2 border-t border-border-hard">
        <span className="text-[12px] text-txt-tertiary">
          {t('voice:streamSettings.summary', {
            bitrate: formatBitrate(result.publish.videoEncoding.maxBitrate),
            degradation: formatDegradation(result.overdrive.degradationPreference),
          })}
        </span>
      </div>
    </div>,
    portalContainer,
  );
}
