import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_VOICE_BITRATE_KBPS,
  VOICE_BITRATE_OPTIONS_KBPS,
  type VoiceBitrateKbps,
} from '@backspace/shared/src/constants';

interface VoiceQualitySettingProps {
  /** The stored ceiling in kbps; a channel from an older server has none. */
  value: number | undefined;
  /** Without it the stored preset is shown and cannot be changed. */
  canEdit: boolean;
  /**
   * Persists the preset. Rejects on failure: the caller shows the error and
   * the group goes back to the stored value.
   */
  onSave: (kbps: VoiceBitrateKbps) => Promise<void>;
}

/**
 * The voice quality choice of a voice channel's settings Overview: one of the
 * `VOICE_BITRATE_OPTIONS_KBPS` presets, saved as soon as it is picked.
 *
 * It follows the stored value, so a change another admin makes arrives through
 * `channel_updated` and moves the selection. While a save is in flight the
 * picked option shows as selected and the group is disabled, so two quick
 * clicks cannot race each other.
 */
export function VoiceQualitySetting({ value, canEdit, onSave }: VoiceQualitySettingProps) {
  const { t } = useTranslation('spaces');
  const groupId = useId();
  const [pending, setPending] = useState<VoiceBitrateKbps | null>(null);

  const stored = value ?? DEFAULT_VOICE_BITRATE_KBPS;
  const selected = pending ?? stored;

  const choose = async (kbps: VoiceBitrateKbps): Promise<void> => {
    if (!canEdit || pending !== null || kbps === stored) return;
    setPending(kbps);
    try {
      await onSave(kbps);
    } catch {
      // The caller shows the error; the group returns to the stored value.
    } finally {
      setPending(null);
    }
  };

  return (
    <div>
      <span id={`${groupId}-label`} className="block text-xs font-bold text-txt-secondary uppercase mb-2">
        {t('channel.settings.voiceQuality.label')}
      </span>
      <fieldset
        role="radiogroup"
        aria-labelledby={`${groupId}-label`}
        disabled={!canEdit || pending !== null}
        className="min-w-0 space-y-1.5 rounded-lg bg-wash/[0.02] p-1.5"
      >
        {VOICE_BITRATE_OPTIONS_KBPS.map((kbps) => (
          <label
            key={kbps}
            className={`flex items-start gap-3 p-2.5 rounded transition-colors ${
              canEdit ? 'cursor-pointer' : 'cursor-default'
            } ${selected === kbps ? 'bg-interactive-selected' : canEdit ? 'hover:bg-interactive-hover' : ''}`}
          >
            <input
              type="radio"
              name={`${groupId}-bitrate`}
              value={kbps}
              checked={selected === kbps}
              disabled={!canEdit || pending !== null}
              onChange={() => { void choose(kbps); }}
              aria-describedby={`${groupId}-${kbps}-description`}
              className="mt-0.5 accent-accent-primary"
            />
            <div>
              <div className="text-sm font-medium text-txt-primary">
                {t('channel.settings.voiceQuality.option', { value: kbps })}
              </div>
              <div id={`${groupId}-${kbps}-description`} className="text-xs text-txt-tertiary">
                {t(`channel.settings.voiceQuality.description.${kbps}`)}
              </div>
            </div>
          </label>
        ))}
      </fieldset>
      <p className="text-xs text-txt-tertiary mt-2">{t('channel.settings.voiceQuality.hint')}</p>
    </div>
  );
}
