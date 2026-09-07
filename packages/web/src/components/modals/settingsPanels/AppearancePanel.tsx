import { useTranslation } from 'react-i18next';
import { LanguageSection } from './LanguageSection';
import { InterfaceScaleSection } from './InterfaceScaleSection';

/**
 * Presentation preferences that belong to this browser or app rather than to
 * the account: they are stored locally and they apply on the login screen,
 * before there is an account at all.
 */
export function AppearancePanel() {
  const { t } = useTranslation(['settings']);

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-txt-primary mb-6">{t('settings:appearance.title')}</h2>
      <LanguageSection />
      <InterfaceScaleSection />
    </div>
  );
}
