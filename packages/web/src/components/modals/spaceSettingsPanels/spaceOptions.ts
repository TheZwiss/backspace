import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { AvatarColor, SpaceVisibility } from '@backspace/shared';

export interface VisibilityOption {
  value: SpaceVisibility;
  label: string;
  desc: string;
}

/**
 * The three visibility choices with their wording in the current language.
 * Shared by the create-space modal and the discovery panel so both describe
 * the same setting in the same words.
 */
export function useVisibilityOptions(): VisibilityOption[] {
  const { t } = useTranslation(['spaces', 'common']);
  return useMemo(() => [
    {
      value: 'private',
      label: t('spaces:settings.discovery.visibility.options.private.label'),
      desc: t('spaces:settings.discovery.visibility.options.private.description'),
    },
    {
      value: 'request',
      label: t('spaces:settings.discovery.visibility.options.request.label'),
      desc: t('spaces:settings.discovery.visibility.options.request.description'),
    },
    {
      value: 'public',
      label: t('spaces:settings.discovery.visibility.options.public.label'),
      desc: t('spaces:settings.discovery.visibility.options.public.description'),
    },
  ], [t]);
}

/** Tooltip names for the icon colour swatches, keyed by `AvatarColor`. */
export function useAvatarColorNames(): Record<AvatarColor, string> {
  const { t } = useTranslation(['spaces', 'common']);
  return useMemo(() => ({
    mint: t('common:colors.mint'),
    sky: t('common:colors.sky'),
    lavender: t('common:colors.lavender'),
    coral: t('common:colors.coral'),
    rose: t('common:colors.rose'),
    teal: t('common:colors.teal'),
    amber: t('common:colors.amber'),
  }), [t]);
}
