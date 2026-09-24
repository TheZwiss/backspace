import React, { type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import type { HubUpdateState } from '../../stores/projectHubStore';
import { releaseNotesUrl } from '../../utils/projectLinks';
import { HubCard, HubLinkAction } from './HubCard';

function WhatsNewIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0l1.58 6.14a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
    </svg>
  );
}

/**
 * "What's new": which version the home instance runs, whether that is news to
 * this user, and a link to its release notes on GitHub (or to the release
 * list when the version has no upstream tag or is unknown).
 *
 * Takes the update state rather than reading it, because the page passes the
 * snapshot it took on arrival: the card keeps saying "Updated to" for the
 * whole visit while the dot elsewhere clears at once.
 */
export function WhatsNewCard(props: { state: HubUpdateState; version: string | null }): JSX.Element {
  const { state, version } = props;
  const { t } = useTranslation('project');

  const line = version === null
    ? t('whatsNew.noVersion')
    : state === 'updated'
      ? t('whatsNew.updated', { version })
      : t('whatsNew.current', { version });

  return (
    <HubCard accent="lavender" icon={<WhatsNewIcon />} title={t('whatsNew.title')} body={line}>
      <HubLinkAction href={releaseNotesUrl(version)}>{t('whatsNew.action')}</HubLinkAction>
    </HubCard>
  );
}
