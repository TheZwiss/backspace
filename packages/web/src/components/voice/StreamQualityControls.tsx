import React from 'react';
import { useTranslation } from 'react-i18next';
import { useVoiceStore } from '../../stores/voiceStore';
import type { ScreenShareConfig, ScreenShareAudioState } from '../../stores/voiceStore';
import { buildScreenShareOptions, effectiveScreenShareConfig } from '../../utils/screenShare';
import { DEFAULT_STREAMING_LIMITS } from '../../stores/settingsStore';
import { useStreamHostLimits } from '../../utils/streamHostLimits';
import { hostOf } from '../../utils/identity';
import { Toggle } from '../ui/Toggle';
import { isElectron } from '../../platform/platform';
import { RESOLUTION_LABELS } from '@backspace/shared/src/constants';
import i18n from '../../i18n';
import { formatters } from '../../i18n/formatters';

/**
 * The stream quality controls (resolution, frame rate, content mode, codec,
 * bitrate, system audio) bound to voiceStore.screenShareConfig.
 *
 * Shared by the two places a user tunes a stream: ScreenShareSetup before it
 * starts, and ScreenShareSettingsPopover while it is live. Presentation-only:
 * the pills show the effective config (`effectiveScreenShareConfig`, the saved
 * choice fitted to the limits of the instance hosting the call, see
 * `utils/streamHostLimits.ts`), and only a click saves. The limits never write
 * into the saved config, so a strict host does not lower it for later streams.
 */

const MODES: { value: ScreenShareConfig['mode']; labelKey: 'voice:streamSettings.mode.gaming' | 'voice:streamSettings.mode.text' }[] = [
  { value: 'gaming', labelKey: 'voice:streamSettings.mode.gaming' },
  { value: 'text', labelKey: 'voice:streamSettings.mode.text' },
];

const CODEC_OPTIONS = [
  { value: 'vp9' as const, labelKey: 'voice:streamSettings.codecOption.vp9' as const },
  { value: 'h264' as const, labelKey: 'voice:streamSettings.codecOption.h264' as const },
];

/** Whole Mbps when the value is round, otherwise one decimal; the number goes through the locale. */
export function formatBitrate(bps: number): string {
  const mbps = bps % 1_000_000 === 0 ? bps / 1_000_000 : Math.round(bps / 100_000) / 10;
  return i18n.t('common:units.mbps', { value: formatters.formatNumber(mbps) });
}

export function formatDegradation(pref: RTCDegradationPreference): string {
  switch (pref) {
    case 'maintain-resolution': return i18n.t('voice:streamSettings.degradation.maintainResolution');
    case 'maintain-framerate': return i18n.t('voice:streamSettings.degradation.maintainFramerate');
    case 'balanced': return i18n.t('voice:streamSettings.degradation.balanced');
    default: return pref;
  }
}

export function formatKbps(kbps: number): string {
  if (kbps >= 1000) {
    const mbps = kbps % 1000 === 0 ? kbps / 1000 : Math.round(kbps / 100) / 10;
    return i18n.t('common:units.mbps', { value: formatters.formatNumber(mbps) });
  }
  return i18n.t('common:units.kbps', { value: formatters.formatNumber(kbps) });
}

/**
 * "Limits set by <host>" under the Stream Settings title, when the call is
 * hosted by an instance other than home. Nothing at home, and nothing when
 * the host is unknown (a relayed DM token), where the defaults apply.
 */
export function StreamHostSubtitle({ className = '' }: { className?: string }) {
  const { t } = useTranslation(['voice']);
  const { origin } = useStreamHostLimits();
  if (!origin) return null;
  return (
    <div className={`text-[11px] text-txt-tertiary break-all ${className}`}>
      {t('voice:streamSettings.hostLimits', { host: hostOf(origin) })}
    </div>
  );
}

/** "4 Mbps · balanced" — the computed outcome of the current config. */
export function StreamSummary({ className = '' }: { className?: string }) {
  const { t } = useTranslation(['voice', 'common']);
  const config = useVoiceStore((s) => s.screenShareConfig);
  const result = buildScreenShareOptions(config);
  return (
    <span className={`text-[12px] text-txt-tertiary ${className}`}>
      {t('voice:streamSettings.summary', {
        bitrate: formatBitrate(result.publish.videoEncoding.maxBitrate),
        degradation: formatDegradation(result.overdrive.degradationPreference),
      })}
    </span>
  );
}

/**
 * What the System Audio switch shows and allows.
 *
 * Before a share it is the preference, read when the capture is taken. While
 * a share is live it is what the share sends (`screenShareAudio`): the
 * preference can be on while nothing goes out (a browser capture without
 * audio), and a switch reading "on" there would be claiming audio viewers do
 * not get. Turning it off always works; turning it on is offered only where
 * `syncScreenShareAudio` can act on it.
 */
export function systemAudioSwitch(
  isScreenSharing: boolean,
  liveAudio: ScreenShareAudioState | null,
  preference: boolean,
): { checked: boolean; disabled: boolean; cannotAddLive: boolean } {
  if (!isScreenSharing || liveAudio === null) return { checked: preference, disabled: false, cannotAddLive: false };
  switch (liveAudio) {
    case 'published': return { checked: true, disabled: false, cannotAddLive: false };
    case 'acquiring': return { checked: true, disabled: true, cannotAddLive: false };
    case 'held':
    case 'acquirable': return { checked: false, disabled: false, cannotAddLive: false };
    case 'unavailable': return { checked: false, disabled: true, cannotAddLive: true };
  }
}

const pillBase = 'px-2.5 py-1.5 rounded-full text-[13px] font-medium transition-colors cursor-pointer select-none text-center';
const pillSelected = 'bg-accent-primary text-white';
const pillUnselected = 'bg-surface-elevated text-txt-secondary hover:bg-interactive-hover';

export function StreamQualityControls() {
  const { t } = useTranslation(['voice', 'common']);
  const config = useVoiceStore((s) => s.screenShareConfig);
  const setConfig = useVoiceStore((s) => s.setScreenShareConfig);
  const { origin: hostOrigin, limits } = useStreamHostLimits();
  const electronPlatform = isElectron() ? window.backspace?.platform : null;
  const isScreenSharing = useVoiceStore((s) => s.isScreenSharing);
  const liveAudio = useVoiceStore((s) => s.screenShareAudio);
  const audioSwitch = systemAudioSwitch(isScreenSharing, liveAudio, config.shareAudio);

  // Unknown limits (not yet fetched, or a host that cannot be asked) show the
  // same defaults the stream itself falls back to.
  const hostLimits = limits ?? DEFAULT_STREAMING_LIMITS;
  const effective = effectiveScreenShareConfig(config, hostLimits);

  const RESOLUTIONS = hostLimits.allowedResolutions.map((r) => ({
    value: r as ScreenShareConfig['height'],
    label: RESOLUTION_LABELS[r as keyof typeof RESOLUTION_LABELS] ?? `${r}p`,
  }));
  const FRAME_RATES = hostLimits.allowedFramerates.map((f) => ({
    value: f as ScreenShareConfig['fps'],
    label: `${f}`,
  }));

  const result = buildScreenShareOptions(config);
  // What Auto resolves to right now, in kbps; also the slider's starting point when switching to Custom
  const autoKbps = Math.round(result.publish.videoEncoding.maxBitrate / 1000);

  return (
    <div className="flex flex-col gap-3">
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
              aria-pressed={effective.height === r.value}
              className={`${pillBase} ${effective.height === r.value ? pillSelected : pillUnselected}`}
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
              aria-pressed={effective.fps === f.value}
              className={`${pillBase} ${effective.fps === f.value ? pillSelected : pillUnselected}`}
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
              aria-pressed={config.mode === m.value}
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
            const isSelected = config.codec === c.value;
            return (
              <button
                key={c.value}
                onClick={() => setConfig({ codec: c.value })}
                aria-pressed={isSelected}
                className={`${pillBase} ${isSelected ? pillSelected : pillUnselected}`}
              >
                {t(c.labelKey)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Bitrate — Auto | Custom pills like every other row; the slider only exists in Custom */}
      <div>
        <div className="text-[11px] text-txt-tertiary font-semibold uppercase tracking-wider mb-1.5">
          {t('voice:streamSettings.bitrate')}
        </div>
        {hostLimits.allowCustomBitrate ? (
          <>
            <div className="flex gap-1.5">
              <button
                onClick={() => setConfig({ customBitrateKbps: null })}
                aria-pressed={effective.customBitrateKbps == null}
                className={`${pillBase} ${effective.customBitrateKbps == null ? pillSelected : pillUnselected}`}
              >
                {t('voice:streamSettings.auto')}
              </button>
              <button
                onClick={() => {
                  // Start the slider where Auto currently sits so switching changes nothing yet
                  if (effective.customBitrateKbps == null) setConfig({ customBitrateKbps: autoKbps });
                }}
                aria-pressed={effective.customBitrateKbps != null}
                className={`${pillBase} ${effective.customBitrateKbps != null ? pillSelected : pillUnselected}`}
              >
                {t('voice:streamSettings.custom')}
              </button>
            </div>
            {effective.customBitrateKbps != null && (
              <div className="flex items-center gap-2 mt-2">
                <input
                  type="range"
                  min={hostLimits.minBitrateKbps}
                  max={hostLimits.maxBitrateKbps}
                  step={hostLimits.bitrateStepKbps}
                  value={effective.customBitrateKbps}
                  onChange={(e) => setConfig({ customBitrateKbps: Number(e.target.value) })}
                  className="flex-1 min-w-0 h-1.5 accent-accent-primary cursor-pointer appearance-none bg-interactive-muted rounded-full
                    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
                    [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md
                    [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:border-0
                    [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full
                    [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:cursor-pointer"
                />
                <span className="text-[12px] font-medium text-txt-primary min-w-[64px] flex-shrink-0 text-right">
                  {formatKbps(effective.customBitrateKbps)}
                </span>
              </div>
            )}
          </>
        ) : (
          <div>
            <div className="text-[12px] text-txt-secondary font-medium">
              {formatKbps(autoKbps)}
            </div>
            <div className="text-[10px] text-txt-tertiary mt-0.5">
              {hostOrigin
                ? t('voice:streamSettings.customBitrateDisabledByHost', { host: hostOf(hostOrigin) })
                : t('voice:streamSettings.customBitrateDisabled')}
            </div>
          </div>
        )}
      </div>

      {/* System Audio */}
      <div>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1 pt-1">
            <div className="text-[11px] text-txt-tertiary font-semibold uppercase tracking-wider">
              {t('voice:streamSettings.systemAudio')}
            </div>
            {audioSwitch.cannotAddLive && (
              <div className="text-[10px] text-txt-tertiary mt-0.5">
                {t('voice:streamSettings.systemAudioLiveUnavailable')}
              </div>
            )}
            {audioSwitch.checked && (
              <div className="text-[10px] text-accent-amber/80 mt-0.5">
                {electronPlatform === 'win32'
                  ? t('voice:streamSettings.electronWindowsAudioNote')
                  : electronPlatform === 'darwin'
                    ? t('voice:streamSettings.electronMacAudioNote')
                    : electronPlatform === 'linux'
                      ? t('voice:streamSettings.electronLinuxAudioNote')
                      : t('voice:streamSettings.chromeEchoNote')}
              </div>
            )}
          </div>
          <Toggle
            enabled={audioSwitch.checked}
            disabled={audioSwitch.disabled}
            onChange={(enabled) => setConfig({ shareAudio: enabled })}
            ariaLabel={t('voice:streamSettings.systemAudio')}
          />
        </div>
      </div>
    </div>
  );
}
