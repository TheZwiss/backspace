import { useTranslation } from 'react-i18next';
import { useNudgePreferences } from '../../../stores/nudgePreferences';
import type { NudgeRules } from '../../../utils/nudgePolicy';
import { Toggle } from '../../ui/Toggle';
import { useFormatters } from '../../../i18n/formatters';

export function NudgePreferencesSection() {
  const { t } = useTranslation(['settings']);
  const f = useFormatters();
  const preferences = useNudgePreferences();
  const select = <K extends keyof NudgeRules>(key: K, label: string, options: [NudgeRules[K], string][]) => <label className="block space-y-1.5">
    <span className="text-sm text-txt-primary">{label}</span>
    <select value={String(preferences[key])} onChange={event => preferences.update({ [key]: event.target.value })}
      className="w-full rounded-md bg-surface-input border border-border-soft px-3 py-2 text-sm text-txt-primary">
      {options.map(([value, title]) => <option key={String(value)} value={String(value)}>{title}</option>)}
    </select>
  </label>;
  return <section className="rounded-[10px] border border-border-soft bg-surface-elevated p-4 space-y-4">
    <div><h3 className="text-sm font-semibold text-txt-primary">{t('settings:notifications.attentionTitle')}</h3>
      <p className="text-xs text-txt-secondary mt-1">{t('settings:notifications.attentionDescription')}</p></div>
    {select('scope', t('settings:notifications.scopeLabel'), [['both', t('settings:notifications.scopeBoth')], ['app', t('settings:notifications.scopeApp')], ['desktop', t('settings:notifications.scopeDesktop')], ['off', t('settings:notifications.scopeOff')]])}
    {preferences.scope !== 'off' && <>
      {select('mode', t('settings:notifications.modeLabel'), [['full', t('settings:notifications.modeFull')], ['reduced', t('settings:notifications.modeReduced')], ['notification', t('settings:notifications.modeNotification')]])}
      <div className="flex items-center justify-between gap-4 border-t border-border-soft pt-4"><span className="text-sm text-txt-primary">{t('settings:notifications.soundLabel')}</span><Toggle enabled={preferences.sound} onChange={sound => preferences.update({ sound })} ariaLabel={t('settings:notifications.soundLabel')} /></div>
      {preferences.sound && <div><div className="flex justify-between items-center mb-2 gap-4"><label htmlFor="nudge-sound-volume" className="text-sm text-txt-primary">{t('settings:notifications.volumeLabel')}</label><output htmlFor="nudge-sound-volume" className="text-xs text-txt-secondary tabular-nums">{f.formatPercent(preferences.volume)}</output></div>
        <input id="nudge-sound-volume" type="range" min={0} max={100} value={preferences.volume} onChange={event => preferences.update({ volume: Number(event.target.value) })}
          className="w-full h-1.5 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
          style={{ background: `linear-gradient(to right, rgb(var(--accent-primary)) ${preferences.volume}%, rgb(var(--interactive-muted)) ${preferences.volume}%)` }} /></div>}
      {preferences.scope !== 'app' && select('monitor', t('settings:notifications.monitorLabel'), [['all', t('settings:notifications.monitorAll')], ['primary', t('settings:notifications.monitorPrimary')], ['app', t('settings:notifications.monitorApp')], ['secondary', t('settings:notifications.monitorSecondary')]])}
      <div className="border-t border-border-soft pt-4 space-y-4">
        <h4 className="text-sm font-semibold text-txt-primary">{t('settings:notifications.gameTitle')}</h4>
        {select('gameDetection', t('settings:notifications.gameDetectionLabel'), [['auto', t('settings:notifications.gameDetectionAuto')], ['on', t('settings:notifications.gameDetectionOn')], ['off', t('settings:notifications.gameDetectionOff')]])}
        {preferences.gameDetection !== 'off' && <>
          {preferences.gameDetection === 'auto' && select('gameTrigger', t('settings:notifications.gameTriggerLabel'), [['foreground', t('settings:notifications.gameTriggerForeground')], ['running', t('settings:notifications.gameTriggerRunning')]])}
          {select('gameAction', t('settings:notifications.gameActionLabel'), [['notification', t('settings:notifications.notificationOnly')], ['other-displays', t('settings:notifications.gameOtherDisplays')], ['off', t('settings:notifications.gameSuppress')], ['normal', t('settings:notifications.gameNormal')]])}
          {preferences.gameAction === 'other-displays' && <>
            {select('gameMonitor', t('settings:notifications.gameMonitorLabel'), [['auto', t('settings:notifications.gameMonitorAuto')], ['primary', t('settings:notifications.gameMonitorPrimary')], ['app', t('settings:notifications.gameMonitorApp')], ['secondary', t('settings:notifications.gameMonitorSecondary')]])}
            {select('gameFallback', t('settings:notifications.gameFallbackLabel'), [['notification', t('settings:notifications.notificationOnly')], ['app', t('settings:notifications.gameFallbackApp')], ['off', t('settings:notifications.gameFallbackOff')]])}
          </>}
          <p className="text-xs text-txt-secondary">{t('settings:notifications.gameHelp')}</p>
        </>}
      </div>
      <p className="text-xs text-txt-secondary">{t('settings:notifications.appHelp')}</p>
    </>}
  </section>;
}
