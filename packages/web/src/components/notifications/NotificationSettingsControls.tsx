import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_NOTIFICATION_LEVEL,
  isMuteActive,
  resolveChannelNotificationPolicy,
  type NotificationLevel,
  type NotificationMuteDuration,
  type UpdateNotificationSettingRequest,
} from '@backspace/shared';
import { describeCodedError } from '../../i18n/errors';
import { useFormatters } from '../../i18n/formatters';
import { useUIStore } from '../../stores/uiStore';
import {
  selectNotificationSetting,
  useNotificationSettingsStore,
} from '../../stores/notificationSettingsStore';

/**
 * The level choice and the mute options for one space (`channelId` null) or
 * one channel of it. Shared by the channel header's bell popover and the
 * notification settings dialog; the surface around it (glass popover or
 * glass modal) is the caller's.
 *
 * `origin` is the instance that hosts the space: the settings are read from
 * and written to that instance (docs/systems/sounds.md, "Notification
 * settings").
 */
export interface NotificationSettingsControlsProps {
  origin: string;
  spaceId: string;
  channelId: string | null;
}

/** A level row's value: a level, or `inherit` for a channel that follows its space. */
type LevelChoice = NotificationLevel | 'inherit';

const LEVELS: readonly NotificationLevel[] = ['all', 'mentions', 'nothing'];
const MUTE_DURATIONS: readonly NotificationMuteDuration[] = ['1h', '8h', '24h', 'indefinite'];

function RadioDot({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
        checked ? 'border-accent-primary' : 'border-txt-tertiary'
      }`}
    >
      {checked && <span className="w-2 h-2 rounded-full bg-accent-primary" />}
    </span>
  );
}

export function NotificationSettingsControls({ origin, spaceId, channelId }: NotificationSettingsControlsProps) {
  const { t } = useTranslation(['spaces']);
  const formatters = useFormatters();
  const addToast = useUIStore((s) => s.addToast);
  const update = useNotificationSettingsStore((s) => s.update);
  const own = useNotificationSettingsStore((s) => selectNotificationSetting(s, origin, { spaceId, channelId }));
  const spaceSetting = useNotificationSettingsStore((s) => selectNotificationSetting(s, origin, { spaceId, channelId: null }));
  // Re-render when a timed mute ends while the controls are open.
  useNotificationSettingsStore((s) => s.clock);
  const [saving, setSaving] = useState(false);
  const levelHeadingId = useId();

  const isChannel = channelId !== null;
  const now = Date.now();
  const ownMuted = isMuteActive(own, now);
  const spaceMuted = isChannel && isMuteActive(spaceSetting, now);
  // What a channel inherits, shown on its "Space default" row.
  const inheritedLevel = resolveChannelNotificationPolicy(spaceSetting, undefined, now).level;

  const selected: LevelChoice = own?.level ?? (isChannel ? 'inherit' : DEFAULT_NOTIFICATION_LEVEL);
  const choices: readonly LevelChoice[] = isChannel ? ['inherit', ...LEVELS] : LEVELS;

  const levelLabel = (level: NotificationLevel): string => {
    switch (level) {
      case 'all': return t('spaces:notifications.level.all');
      case 'mentions': return t('spaces:notifications.level.mentions');
      case 'nothing': return t('spaces:notifications.level.nothing');
    }
  };

  const choiceLabel = (choice: LevelChoice): string =>
    choice === 'inherit'
      ? t('spaces:notifications.level.inherit', { level: levelLabel(inheritedLevel) })
      : levelLabel(choice);

  const durationLabel = (duration: NotificationMuteDuration): string => {
    switch (duration) {
      case '1h': return t('spaces:notifications.mute.oneHour');
      case '8h': return t('spaces:notifications.mute.eightHours');
      case '24h': return t('spaces:notifications.mute.oneDay');
      case 'indefinite': return t('spaces:notifications.mute.indefinite');
    }
  };

  const formatMuteEnd = (end: number): string => {
    const sameDay = new Date(end).toDateString() === new Date(now).toDateString();
    return sameDay ? formatters.formatTime(end) : formatters.formatDateTime(end);
  };

  const save = async (change: UpdateNotificationSettingRequest): Promise<void> => {
    setSaving(true);
    try {
      await update(origin, { spaceId, channelId }, change);
    } catch (err) {
      addToast(
        describeCodedError(err, t('spaces:notifications.saveFailed')),
        'warning',
        4000,
      );
    } finally {
      setSaving(false);
    }
  };

  const onChoose = (choice: LevelChoice): void => {
    if (choice === selected || saving) return;
    // A space has no "inherit": clearing it is choosing the default.
    void save({ level: choice === 'inherit' ? null : choice });
  };

  const onRadioKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const delta = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    const next = choices[(index + delta + choices.length) % choices.length];
    if (next === undefined) return;
    onChoose(next);
    const group = e.currentTarget.parentElement;
    const target = group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[(index + delta + choices.length) % choices.length];
    target?.focus();
  };

  return (
    <div className="flex flex-col gap-3" aria-busy={saving}>
      <div>
        <div id={levelHeadingId} className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-txt-tertiary">
          {t('spaces:notifications.levelHeading')}
        </div>
        <div role="radiogroup" aria-labelledby={levelHeadingId} className="flex flex-col gap-[2px]">
          {choices.map((choice, index) => {
            const checked = choice === selected;
            return (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                disabled={saving}
                onClick={() => onChoose(choice)}
                onKeyDown={(e) => onRadioKeyDown(e, index)}
                className={`w-full flex items-center gap-2.5 px-2.5 h-9 rounded-[6px] text-left text-[14px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:opacity-60 ${
                  checked ? 'text-txt-primary bg-interactive-selected' : 'text-txt-secondary hover:text-txt-primary hover:bg-interactive-hover'
                }`}
              >
                <RadioDot checked={checked} />
                <span className="truncate">{choiceLabel(choice)}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="h-px bg-glass-border" />

      <div>
        <div className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-txt-tertiary">
          {t('spaces:notifications.muteHeading')}
        </div>
        {ownMuted && own ? (
          <div className="flex items-center justify-between gap-3 px-2.5 py-1.5">
            <span className="text-[13px] text-txt-secondary min-w-0">
              {own.mutedUntil === null
                ? t('spaces:notifications.mutedIndefinitely')
                : t('spaces:notifications.mutedUntil', { time: formatMuteEnd(own.mutedUntil) })}
            </span>
            <button
              type="button"
              disabled={saving}
              onClick={() => void save({ mute: null })}
              className="flex-shrink-0 px-3 h-8 rounded-[6px] text-[13px] font-medium text-txt-primary bg-interactive-hover hover:bg-interactive-active transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:opacity-60"
            >
              {t('spaces:notifications.unmute')}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-1">
            {MUTE_DURATIONS.map((duration) => (
              <button
                key={duration}
                type="button"
                disabled={saving}
                onClick={() => void save({ mute: duration })}
                className="px-2.5 h-8 rounded-[6px] text-left text-[13px] text-txt-secondary hover:text-txt-primary hover:bg-interactive-hover transition-colors truncate focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:opacity-60"
              >
                {durationLabel(duration)}
              </button>
            ))}
          </div>
        )}
        {spaceMuted && (
          <p className="px-2.5 pt-1.5 text-[12px] text-accent-amber">{t('spaces:notifications.spaceMuted')}</p>
        )}
      </div>

      {!isChannel && (
        <div className="flex flex-col gap-2 px-1">
          {(['suppressEveryone', 'suppressRoles'] as const).map(field => (
            <label key={field} className="flex items-center gap-2 text-[13px] text-txt-secondary">
              <input type="checkbox" checked={own?.[field] === true} disabled={saving}
                onChange={e => void save({ [field]: e.target.checked })} />
              {t(`spaces:notifications.${field}`)}
            </label>
          ))}
        </div>
      )}

      <p className="px-1 text-[12px] text-txt-tertiary">{t('spaces:notifications.dmNote')}</p>
    </div>
  );
}
