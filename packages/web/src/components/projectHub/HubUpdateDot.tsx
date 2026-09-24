import React, { type JSX } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The dot that says the instance updated since the user last opened the
 * Backspace page: the brand primary 8px dot, informational rather than the
 * red "needs you" dot. The desktop sidebar item and the mobile You-screen row
 * draw this one component; the caller decides when (`useHubUpdateState`
 * returning `updated`) and where (`className`, for example `ml-auto`).
 */
export function HubUpdateDot(props: { className?: string }): JSX.Element {
  const { className } = props;
  const { t } = useTranslation('project');
  return (
    <span
      role="img"
      aria-label={t('nav.updatedDot')}
      className={`w-2 h-2 rounded-full bg-accent-primary flex-shrink-0${className ? ` ${className}` : ''}`}
    />
  );
}
