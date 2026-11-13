import { AttentionMutedUsersSection } from './AttentionMutedUsersSection';
import { FriendNotificationSettingsSection } from './FriendNotificationSettingsSection';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVoiceStore } from '../../../stores/voiceStore';
import { useFormatters } from '../../../i18n/formatters';
import { isElectron } from '../../../platform/platform';
import { requestNotificationPermission } from '../../../platform/notifications';
import { Toggle } from '../../ui/Toggle';
import { NudgePreferencesSection } from './NudgePreferencesSection';

export function NotificationsPanel() {
  const { t } = useTranslation(['settings']);
  const f = useFormatters();
  const volume = useVoiceStore(s => s.soundEffectVolume);
  const setVolume = useVoiceStore(s => s.setSoundEffectVolume);
  const everyMessage = useVoiceStore(s => s.messageSoundAllChannels);
  const setEveryMessage = useVoiceStore(s => s.setMessageSoundAllChannels);
  const [permission, setPermission] = useState(() => typeof Notification === 'undefined' ? 'unavailable' : Notification.permission);
  return <div className="space-y-5">
    <header><h2 className="text-lg font-semibold text-txt-primary">{t('settings:nav.tabs.notifications')}</h2>
      <p className="text-sm text-txt-secondary mt-2">{t('settings:notifications.description')}</p></header>
    <section className="settings-section space-y-4" aria-labelledby="notification-sounds-heading">
      <div><h3 id="notification-sounds-heading" className="text-sm font-semibold text-txt-primary">{t('settings:notifications.soundsTitle')}</h3>
        <p className="text-xs text-txt-secondary mt-1">{t('settings:notifications.soundsDescription')}</p></div>
      <div><div className="flex items-center justify-between gap-4 mb-2">
        <label htmlFor="notification-sfx-volume" className="text-sm text-txt-primary">{t('settings:voice.volume.soundEffects.label')}</label>
        <output htmlFor="notification-sfx-volume" className="text-xs text-txt-secondary tabular-nums">{f.formatPercent(volume)}</output>
      </div><input id="notification-sfx-volume" type="range" min={0} max={200} value={volume} onChange={event => setVolume(Number(event.target.value))}
        className="ui-range"
        style={{ background: `linear-gradient(to right, rgb(var(--accent-primary)) ${volume / 2}%, rgb(var(--interactive-muted)) ${volume / 2}%)` }} /></div>
      <div className="flex items-center justify-between gap-4">
        <div><p className="text-sm text-txt-primary">{t('settings:voice.volume.messageSound.label')}</p>
          <p className="text-xs text-txt-secondary mt-1">{t('settings:voice.volume.messageSound.description')}</p></div>
        <Toggle enabled={everyMessage} onChange={setEveryMessage} ariaLabel={t('settings:voice.volume.messageSound.label')} />
      </div>
    </section>
    <section className="settings-section space-y-2">
      <h3 className="text-sm font-semibold text-txt-primary">{t('settings:notifications.messagesTitle')}</h3>
      <p className="text-xs text-txt-secondary">{t('settings:notifications.messagesDescription')}</p>
      {isElectron() ? <p className="text-xs text-txt-tertiary">{t('settings:notifications.systemDescription')}</p>
        : <div className="flex flex-wrap items-center gap-3 pt-1"><span className="text-xs text-txt-secondary">{permission === 'granted' ? t('settings:notifications.permissionGranted') : permission === 'denied' ? t('settings:notifications.permissionDenied') : permission === 'unavailable' ? t('settings:notifications.permissionUnavailable') : t('settings:notifications.permissionDefault')}</span>
          {permission === 'default' && <button data-icon-motion="bell" type="button" className="ui-button ui-button-primary" onClick={async () => { await requestNotificationPermission(); setPermission(Notification.permission); }}>{t('settings:notifications.enable')}</button>}</div>}
    </section>
    <FriendNotificationSettingsSection />
    <NudgePreferencesSection />
    <AttentionMutedUsersSection />
  </div>;
}
