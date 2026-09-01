import { useTranslation } from 'react-i18next';
import { resolveSupportedLanguage, supportedLanguages } from '../../i18n';

interface LanguageSwitcherProps {
  compact?: boolean;
}

export function LanguageSwitcher({ compact = false }: LanguageSwitcherProps) {
  const { i18n, t } = useTranslation();
  const value = resolveSupportedLanguage(i18n.resolvedLanguage ?? i18n.language);

  return (
    <label className={compact ? 'inline-flex items-center' : 'block'}>
      {!compact && (
        <span className="block text-xs font-semibold text-txt-secondary mb-2">
          {t("language.current")}
        </span>
      )}
      <select
        className={compact
          ? 'input-standard py-1.5 pl-2 pr-7 text-xs'
          : 'input-standard w-full py-2.5'}
        value={value}
        onChange={(event) => void i18n.changeLanguage(event.target.value)}
        aria-label={t("language.current")}
      >
        {supportedLanguages.map((language) => (
          <option key={language.code} value={language.code}>
            {language.nativeName}
          </option>
        ))}
      </select>
    </label>
  );
}
