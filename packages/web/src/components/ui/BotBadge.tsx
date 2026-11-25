import React from 'react';
import { useTranslation } from 'react-i18next';

interface BotBadgeProps {
  className?: string;
}

export function BotBadge({ className = '' }: BotBadgeProps) {
  const { t } = useTranslation('common');

  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold border-2 border-purple-500 text-purple-500 leading-none ${className}`}
    >
      {t('actions.bot')}
    </span>
  );
}
