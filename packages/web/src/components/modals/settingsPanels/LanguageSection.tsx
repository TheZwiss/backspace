import { useTranslation } from 'react-i18next';
import { availableLanguages, setLanguage, type SupportedLanguage } from '../../../i18n';
import { getLanguage } from '../../../i18n';

/**
 * The language picker. Each option is shown in its own language, and the
 * list is deliberately not translated: a user who cannot read the current
 * language still has to be able to find their own.
 */
export function LanguageSection() {
  const { t } = useTranslation(['common']);
  const current = getLanguage();

  return (
    <div>
      <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
        {t('common:language.label')}
      </div>
      <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5">
        <label htmlFor="language-select" className="block text-xs text-txt-tertiary mb-2">
          {t('common:language.description')}
        </label>
        <select
          id="language-select"
          value={current}
          onChange={(e) => { void setLanguage(e.target.value as SupportedLanguage); }}
          className="input-standard w-full appearance-none"
        >
          {availableLanguages.map((language) => (
            <option key={language.code} value={language.code} lang={language.code}>
              {language.nativeName}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
