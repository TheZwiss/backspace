import { ConnectedInstances } from '../ConnectedInstances';
import { useTranslation } from 'react-i18next';

export function ConnectionsPanel() {
  const { t } = useTranslation();
  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-txt-primary mb-6">{t('common.connections')}</h2>
      <ConnectedInstances />
    </div>
  );
}
