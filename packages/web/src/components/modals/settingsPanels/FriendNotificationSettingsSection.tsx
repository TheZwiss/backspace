import { useTranslation } from 'react-i18next';
import { useFriendNotificationPreferences } from '../../../stores/friendNotificationPreferences';
import { Toggle } from '../../ui/Toggle';
export function FriendNotificationSettingsSection() {
  const { t } = useTranslation('settings');
  const preferences = useFriendNotificationPreferences();
  return <section className="settings-section space-y-3" aria-labelledby="friend-notification-settings-title">
    <div><h3 id="friend-notification-settings-title" className="text-sm font-semibold text-txt-primary">{t('friendNotifications.title')}</h3><p className="text-xs text-txt-secondary mt-1">{t('friendNotifications.description')}</p></div>
    <div className="flex items-center justify-between gap-3"><span className="text-ui-label text-txt-primary">{t('friendNotifications.enabled')}</span><Toggle enabled={preferences.enabled} onChange={enabled => preferences.update({ enabled })} ariaLabel={t('friendNotifications.enabled')} /></div>
    {preferences.enabled && <>
      <div className="flex items-center justify-between gap-3"><span className="text-ui-label text-txt-primary">{t('friendNotifications.sound')}</span><Toggle enabled={preferences.sound} onChange={sound => preferences.update({ sound })} ariaLabel={t('friendNotifications.sound')} /></div>
      <div className="flex items-center justify-between gap-3"><span className="text-ui-label text-txt-primary">{t('friendNotifications.desktop')}</span><Toggle enabled={preferences.desktop} onChange={desktop => preferences.update({ desktop })} ariaLabel={t('friendNotifications.desktop')} /></div>
    </>}
  </section>;
}
