import React, { useEffect, useRef, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { useHubUpdateState } from '../../hooks/useHubUpdateState';
import { useHomeInstanceInfo } from '../../hooks/useHomeInstanceInfo';
import { useAuthStore } from '../../stores/authStore';
import { useProjectHubStore, type HubUpdateState } from '../../stores/projectHubStore';
import { useUIStore } from '../../stores/uiStore';
import { isElectron } from '../../platform/platform';
import { PROJECT_LINKS, type ProjectLinks } from '../../utils/projectLinks';
import { MemberListToggleButton } from '../layout/MemberListToggleButton';
import { BackspaceMark } from './BackspaceMark';
import { CommunityCard } from './CommunityCard';
import { HUB_ACTION, HubCard, HubLinkAction } from './HubCard';
import { InstanceSection } from './InstanceSection';
import { ReportCard } from './ReportCard';
import { WhatsNewCard } from './WhatsNewCard';

// ─── Icons ──────────────────────────────────────────────────────────────────
// 24px outline icons in the text colour; the card's icon tile colours them.

function SupportIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

function InsightsIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 20V10" />
      <path d="M12 20V4" />
      <path d="M6 20v-6" />
    </svg>
  );
}

function HostIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <path d="M6 6h.01" />
      <path d="M6 18h.01" />
    </svg>
  );
}

function DesktopIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </svg>
  );
}

// ─── Seen-version snapshot ──────────────────────────────────────────────────

interface HubSnapshot {
  userId: string;
  state: HubUpdateState;
  version: string;
}

/**
 * The update state as it was when this user arrived on the page, then marks
 * the version seen.
 *
 * The snapshot is taken once per user, on the first render that knows the
 * version, and the What's new card renders from it: it keeps saying "Updated
 * to" for the visit while the sidebar and You-tab dots clear at once. Before
 * the version is known the live state (`unknown`) is returned.
 *
 * The caller must have called `useHubUpdateState()` before this hook. Effects
 * run in call order, so that hook's `load(userId)` has already pointed the
 * store at the signed-in user when the effect here writes; the write also
 * re-checks the loaded user, so an account switch that lands on this page
 * never records the version under the previous account.
 */
function useArrivalSnapshot(live: { state: HubUpdateState; version: string | null }): {
  state: HubUpdateState;
  version: string | null;
} {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const snapshotRef = useRef<HubSnapshot | null>(null);

  if (userId !== null && live.version !== null && snapshotRef.current?.userId !== userId) {
    snapshotRef.current = { userId, state: live.state, version: live.version };
  }
  const snapshot = snapshotRef.current !== null && snapshotRef.current.userId === userId
    ? snapshotRef.current
    : null;

  const seenUser = snapshot?.userId ?? null;
  const seenVersion = snapshot?.version ?? null;
  useEffect(() => {
    if (seenUser === null || seenVersion === null) return;
    const store = useProjectHubStore.getState();
    if (store.userId !== seenUser) return;
    store.markSeen(seenVersion);
  }, [seenUser, seenVersion]);

  return snapshot ?? live;
}

// ─── Page ───────────────────────────────────────────────────────────────────

/**
 * The Backspace page: what the project is, what changed, and where to go for
 * the community, funding, numbers, reports, self-hosting and the desktop app,
 * then which instance the user is on.
 *
 * Used by the desktop route `/backspace` and by the mobile screen, which
 * brings its own header and passes `showTopBar={false}`. `links` defaults to
 * the real constant; tests and the workbench pass filled-in values.
 *
 * Visibility: the community card needs a target, the Support card needs a
 * funding link and loaded instance info that allows it (it fails closed while
 * loading or after a failure, since the admin may have turned it off), and
 * the desktop card is left out inside the desktop app and on the mobile
 * layout. A hidden card leaves no gap in the grid.
 */
export function ProjectHubPage(props: { links?: ProjectLinks; showTopBar?: boolean }): JSX.Element {
  const { links = PROJECT_LINKS, showTopBar = true } = props;
  const { t } = useTranslation('project');

  // First: see useArrivalSnapshot on why this call comes before it.
  const live = useHubUpdateState();
  const arrival = useArrivalSnapshot(live);
  const info = useHomeInstanceInfo();
  const isMobile = useUIStore((s) => s.isMobile);
  const openModal = useUIStore((s) => s.openModal);

  // Null hides the card; `info?.` makes it fail closed while info is loading or failed.
  const funding = info?.supportCardEnabled === true ? links.funding : null;
  const showDesktop = !isElectron() && !isMobile;

  return (
    <div className="flex-1 flex flex-col bg-surface-chat h-full min-w-0">
      {showTopBar && (
        <div className="h-12 px-4 flex items-center shadow-header flex-shrink-0 z-10 bg-surface-chat">
          <div className="flex items-center gap-2 mr-4">
            <BackspaceMark className="text-txt-tertiary" />
            <span className="font-bold text-txt-primary">{t('header.title')}</span>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <MemberListToggleButton />
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="p-6 space-y-10">
          <header className="flex items-center gap-4">
            {/* The space rail's home tile, scaled up: the white mark on the brand lavender. */}
            <div className="w-12 h-12 rounded-2xl bg-accent-primary text-white flex items-center justify-center flex-shrink-0">
              <img src="/icons/logo-mark.svg" alt="" className="w-6 h-auto" />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-txt-primary">{t('header.title')}</h1>
              <p className="text-sm text-txt-secondary">{t('header.tagline')}</p>
            </div>
          </header>

          <div className="card-grid">
            <WhatsNewCard state={arrival.state} version={arrival.version} />

            {links.community !== null && <CommunityCard target={links.community} />}

            {funding !== null && (
              <HubCard accent="peach" icon={<SupportIcon />} title={t('support.title')} body={t('support.body')}>
                <HubLinkAction href={funding}>{t('support.action')}</HubLinkAction>
              </HubCard>
            )}

            <HubCard accent="sky" icon={<InsightsIcon />} title={t('insights.title')} body={t('insights.body')}>
              <HubLinkAction href={links.insights}>{t('insights.action')}</HubLinkAction>
            </HubCard>

            <ReportCard version={live.version} />

            <HubCard accent="coral" icon={<HostIcon />} title={t('host.title')} body={t('host.body')}>
              <HubLinkAction href={links.installGuide}>{t('host.action')}</HubLinkAction>
            </HubCard>

            {showDesktop && (
              <HubCard accent="rose" icon={<DesktopIcon />} title={t('desktop.title')} body={t('desktop.body')}>
                <button
                  type="button"
                  onClick={() => openModal('userSettings', { tab: 'desktop' })}
                  className={HUB_ACTION.quiet}
                >
                  {t('desktop.action')}
                </button>
              </HubCard>
            )}
          </div>

          <InstanceSection info={info} />

          <footer className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
            <a href={links.license} target="_blank" rel="noopener noreferrer" className="text-txt-tertiary hover:text-txt-secondary transition-colors">
              {t('footer.license')}
            </a>
            <a href={links.security} target="_blank" rel="noopener noreferrer" className="text-txt-tertiary hover:text-txt-secondary transition-colors">
              {t('footer.security')}
            </a>
            <a href={links.contributors} target="_blank" rel="noopener noreferrer" className="text-txt-tertiary hover:text-txt-secondary transition-colors">
              {t('footer.contributors')}
            </a>
            <a href={links.repository} target="_blank" rel="noopener noreferrer" className="text-txt-tertiary hover:text-txt-secondary transition-colors">
              {t('footer.source')}
            </a>
          </footer>
        </div>
      </div>
    </div>
  );
}
