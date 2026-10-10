import { useTranslation } from 'react-i18next';
import type { TranslationPreferences, TranslationSettings } from '@backspace/shared/translation';
import { Toggle } from '../../components/ui/Toggle';
const LANGUAGES = {
  'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English', ja: '日本語', ko: '한국어',
  de: 'Deutsch', fr: 'Français', es: 'Español', pt: 'Português', ru: 'Русский', ar: 'العربية',
} as const;
interface ControlsProps {
  preferences: TranslationPreferences;
  settings: TranslationSettings;
  busy: boolean;
  onChange: (preferences: TranslationPreferences) => void;
  onSave: () => void;
}
export function TranslationPreferenceControls({ preferences, settings, busy, onChange, onSave }: ControlsProps) {
  const { t } = useTranslation('translation');
  const consentLabel = t(window.backspace?.translation ? 'consent' : 'serverConsent');
  const update = <K extends keyof TranslationPreferences>(key: K, value: TranslationPreferences[K]) =>
    onChange({ ...preferences, [key]: value });
  return (
    <fieldset disabled={busy} className="space-y-5 min-w-0">
      <legend className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">{t('translationPreferences')}</legend>
      <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 space-y-4">
        <div className="grid grid-cols-1 desktop:grid-cols-2 gap-3">
          <label className="block text-xs font-medium text-txt-secondary">
            {t('globalConnection')}
            <select className="input-standard mt-1.5 w-full" value={preferences.defaultConnection ?? ''}
              onChange={event => update('defaultConnection', event.target.value || null)}>
              <option value="">{t('none')}</option>
              {settings.connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="block text-xs font-medium text-txt-secondary">
            {t('translationEngine')}
            <select className="input-standard mt-1.5 w-full" value={preferences.engine ?? ''}
              onChange={event => update('engine', event.target.value || null)}>
              <option value="">{t('inherit')}</option>
              {settings.connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="google-free">{t('googleFree')}</option>
              <option value="microsoft-free">{t('microsoftFree')}</option>
            </select>
          </label>
        </div>
        {preferences.engine?.endsWith('-free') && <p className="text-xs text-txt-danger leading-relaxed">{t('anonymousWarning')}</p>}
        <label className="block text-xs font-medium text-txt-secondary">
          {t('targetLanguage')}
          <select className="input-standard mt-1.5 w-full" value={preferences.targetLanguage}
            onChange={event => update('targetLanguage', event.target.value as TranslationPreferences['targetLanguage'])}>
            {Object.entries(LANGUAGES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        </label>
      </div>
      <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 divide-y divide-white/[0.06]">
        <div className="flex items-center justify-between gap-4 pb-3">
          <div className="min-w-0">
            <div className="text-sm text-txt-primary">{t('processingConsent')}</div>
            <p className="text-xs text-txt-tertiary mt-1 leading-relaxed">{consentLabel}</p>
          </div>
          <Toggle ariaLabel={consentLabel} enabled={preferences.consent} onChange={enabled =>
            onChange({ ...preferences, consent: enabled, automatic: enabled && preferences.automatic })} />
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <div className="min-w-0">
            <div className="text-sm text-txt-primary">{t('automatic')}</div>
            <p className="text-xs text-txt-tertiary mt-1 leading-relaxed">{t(window.backspace?.translation ? 'automaticHelp' : 'serverAutomaticHelp')}</p>
          </div>
          <Toggle ariaLabel={t('automatic')} enabled={preferences.automatic} disabled={!preferences.consent}
            onChange={enabled => update('automatic', enabled)} />
        </div>
        <div className="flex items-center justify-between gap-4 pt-3">
          <div className="min-w-0">
            <div className="text-sm text-txt-primary">{t('showOriginal')}</div>
            <p className="text-xs text-txt-tertiary mt-1 leading-relaxed">{t('displayHelp')}</p>
          </div>
          <Toggle ariaLabel={t('showOriginal')} enabled={preferences.showOriginal} onChange={enabled => update('showOriginal', enabled)} />
        </div>
      </div>
      <div className="flex justify-end">
        <button type="button" className="px-4 py-2 rounded bg-accent-primary hover:bg-accent-primary-hover text-sm font-medium text-white transition-colors disabled:opacity-50"
          onClick={onSave}>{t('savePreferences')}</button>
      </div>
    </fieldset>
  );
}
