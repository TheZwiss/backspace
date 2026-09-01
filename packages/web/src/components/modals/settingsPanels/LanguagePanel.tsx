import { useTranslation } from 'react-i18next';
import { LanguageSwitcher } from '../../ui/LanguageSwitcher';
import { translate } from '../../../i18n';

export function LanguagePanel() {
  const { t } = useTranslation();

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-txt-primary">{t("language.label")}</h2>
        <p className="text-sm text-txt-tertiary mt-1">{t("language.description")}</p>
      </div>
      <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-4 max-w-md">
        <LanguageSwitcher />
      </div>
    </div>
  );
}
