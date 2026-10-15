import { Fragment, useState, useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { SourceCodeLink } from '../ui/SourceCodeLink';
import { api } from '../../api/client';
import type { InstanceInfoResponse } from '@backspace/shared';
import { useUIStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import {
  TranslationPanel,
  AccountPanel,
  AppearancePanel,
  VoicePanel,
  PrivacyPanel,
  ConnectionsPanel,
  DesktopPanel,
  DesktopDownloadPanel,
  InstancePanel,
  KeybindsPanel,
  SettingsPanelSuspense,
} from './lazySettingsPanels';
import { isElectron } from '../../platform/platform';
import { useInstanceUpdateBadge } from '../../hooks/useInstanceUpdateBadge';
import { SettingsSectionsProvider, useSettingsSectionsContext } from './SettingsSectionsContext';
import { HiButton } from '../telemetry/answers/HiButton';

/**
 * Every tab of user settings, in nav order. The nav on both layouts, the
 * deep-link check (`openModal('userSettings', { tab })`) and the panel switch
 * are all read from this one table, so a tab cannot exist in one and be
 * missing from another. `admin` tabs are shown and reachable only for admins.
 */
const USER_SETTINGS_TABS = [
  { id: 'account', group: 'user', label: 'settings:nav.tabs.account' },
  { id: 'appearance', group: 'user', label: 'settings:nav.tabs.appearance' },
  { id: 'voice', group: 'user', label: 'settings:nav.tabs.voice' },
  { id: 'privacy', group: 'user', label: 'settings:nav.tabs.privacy' },
  { id: 'translation', group: 'app', label: 'translation:title' },
  { id: 'connections', group: 'app', label: 'settings:nav.tabs.connections' },
  { id: 'keybinds', group: 'app', label: 'settings:nav.tabs.keybinds' },
  { id: 'desktop', group: 'app', label: 'settings:nav.tabs.desktop' },
  { id: 'instance', group: 'admin', label: 'settings:nav.tabs.instance' },
] as const;

export type UserSettingsTab = (typeof USER_SETTINGS_TABS)[number]['id'];
type TabGroup = (typeof USER_SETTINGS_TABS)[number]['group'];

const GROUP_HEADINGS = {
  user: 'settings:nav.userSettings',
  app: 'settings:nav.appSettings',
  admin: 'settings:nav.administration',
} as const satisfies Record<TabGroup, string>;

const GROUP_ORDER: readonly TabGroup[] = ['user', 'app', 'admin'];

function isUserSettingsTab(value: unknown): value is UserSettingsTab {
  return typeof value === 'string' && USER_SETTINGS_TABS.some((tab) => tab.id === value);
}

function tabVisible(tab: UserSettingsTab, isAdmin: boolean): boolean {
  return USER_SETTINGS_TABS.find((entry) => entry.id === tab)?.group !== 'admin' || isAdmin;
}

export function SidebarSubLinks() {
  const ctx = useSettingsSectionsContext();
  if (!ctx || ctx.sections.length === 0) return null;

  return (
    <div className="overflow-hidden">
      {ctx.sections.map((section) => (
        section.invite === true ? (
          // Same invitation as the tab strip, sized for the narrow column.
          <div key={section.id} className="flex px-2 py-1.5">
            <HiButton onClick={() => ctx.scrollToSection(section.id)}>{section.label}</HiButton>
          </div>
        ) : (
        <button
          key={section.id}
          onClick={() => ctx.scrollToSection(section.id)}
          className={`w-full flex items-center gap-1.5 text-left pl-6 pr-2 py-1 text-xs rounded-md transition-colors ${
            ctx.activeSection === section.id
              ? 'text-txt-primary'
              : 'text-txt-tertiary hover:text-txt-secondary'
          }`}
          aria-current={ctx.activeSection === section.id ? 'true' : undefined}
        >
          <span className="flex-1 min-w-0 truncate">{section.label}</span>
          {section.badgeCount !== undefined && section.badgeCount > 0 && (
            <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-accent-amber/15 text-accent-amber">
              {section.badgeCount}
            </span>
          )}
          {section.badgeDot === true && (
            <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-accent-amber" />
          )}
        </button>
        )
      ))}
    </div>
  );
}

function SettingsScrollContainer({ children }: { children: React.ReactNode }) {
  const ctx = useSettingsSectionsContext();
  return (
    <div ref={ctx?.scrollContainerRef} className="flex-1 min-w-0 overflow-y-auto scrollbar-thin py-6">
      {children}
    </div>
  );
}

export function UserSettingsModal() {
  const { t } = useTranslation(['settings', 'common', 'translation']);
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData);
  const closeModal = useUIStore((s) => s.closeModal);
  const isMobile = useUIStore((s) => s.isMobile);
  const isAdmin = useAuthStore((s) => s.user?.isAdmin);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const updateBadge = useInstanceUpdateBadge();

  const [tab, setTab] = useState<UserSettingsTab>('account');
  const [mobileView, setMobileView] = useState<'tabs' | 'content'>('tabs');
  // AGPL § 13: home-instance source offer. Fetched from the public info endpoint
  // so the source link reflects the version this instance is actually running.
  const [instanceInfo, setInstanceInfo] = useState<InstanceInfoResponse | null>(null);

  const isOpen = activeModal === 'userSettings';

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    api.instance.info()
      .then((info) => { if (!cancelled) setInstanceInfo(info); })
      .catch(() => { /* Non-critical — link falls back to hidden if unreachable. */ });
    return () => { cancelled = true; };
  }, [isOpen]);

  // Deep-linking: a caller may name the tab to open on. A tab that does not
  // exist, or that this user cannot see, opens Account; on mobile a named tab
  // opens straight on its content.
  useEffect(() => {
    if (isOpen) {
      const requested = modalData.tab;
      const deepLinked = isUserSettingsTab(requested) && tabVisible(requested, isAdmin === true);
      setTab(deepLinked ? requested : 'account');
      setMobileView(deepLinked ? 'content' : 'tabs');
    }
  }, [isOpen, modalData.tab, isAdmin]);

  const handleLogout = () => {
    logout();
    closeModal();
  };

  const tabClass = (target: UserSettingsTab) =>
    `w-full min-w-0 truncate text-left px-3 py-2 rounded-md text-sm transition-colors ${
      tab === target ? 'bg-interactive-selected text-txt-primary font-medium' : 'text-txt-tertiary hover:text-txt-secondary hover:bg-interactive-hover'
    }`;

  const handleTabClick = (target: UserSettingsTab) => {
    setTab(target);
    if (isMobile) setMobileView('content');
  };

  const renderNav = (layout: 'desktop' | 'mobile'): ReactNode =>
    GROUP_ORDER.filter((group) => group !== 'admin' || isAdmin).map((group, index) => (
      <Fragment key={group}>
        {index > 0 && <div className="border-t border-white/[0.04] my-2 mx-2" />}
        <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider px-3 py-1">{t(GROUP_HEADINGS[group])}</div>
        {USER_SETTINGS_TABS.filter((entry) => entry.group === group).map((entry) => (
          entry.id === 'instance' && layout === 'desktop' ? (
            <Fragment key={entry.id}>
              <button
                onClick={() => handleTabClick(entry.id)}
                className={`${tabClass(entry.id)} flex items-center gap-1.5`}
                aria-current={tab === entry.id ? 'page' : undefined}
              >
                <span className="flex-1 min-w-0 truncate">{t(entry.label)}</span>
                {updateBadge && <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-accent-amber" />}
              </button>
              {tab === 'instance' && <SidebarSubLinks />}
            </Fragment>
          ) : (
            <button
              key={entry.id}
              onClick={() => handleTabClick(entry.id)}
              className={tabClass(entry.id)}
              aria-current={tab === entry.id ? 'page' : undefined}
            >
              {t(entry.label)}
            </button>
          )
        ))}
      </Fragment>
    ));

  const panels: Record<UserSettingsTab, () => ReactNode> = {
    translation: () => <TranslationPanel />,
    account: () => <AccountPanel />,
    appearance: () => <AppearancePanel />,
    voice: () => <VoicePanel />,
    privacy: () => <PrivacyPanel />,
    connections: () => <ConnectionsPanel />,
    keybinds: () => <KeybindsPanel />,
    desktop: () => (isElectron()
      ? <DesktopPanel />
      : <DesktopDownloadPanel version={instanceInfo?.version ?? null} />),
    instance: () => (isAdmin ? <InstancePanel /> : null),
  };

  return (
    <Modal isOpen={isOpen} onClose={closeModal} size="settings" mobileStyle="fullscreen">
      <SettingsSectionsProvider>
      <div className="flex h-full">
        {/* Desktop Sidebar */}
        <div className="hidden desktop:flex w-52 flex-shrink-0 flex-col p-4 gap-3">
          {/* User card */}
          <div className="glass-bubble rounded-lg p-3 flex items-center gap-3">
            <Avatar
              src={user?.avatar}
              name={user?.displayName || user?.username || ''}
              size={36}
              userId={user?.id}
              avatarColor={user?.avatarColor}
            />
            <div className="min-w-0">
              <div className="text-sm font-medium text-txt-primary truncate">{user?.displayName || user?.username}</div>
              <div className="text-xs text-txt-tertiary truncate">@{user?.username}</div>
            </div>
          </div>

          {/* Nav list */}
          <div className="glass-bubble rounded-lg p-2 flex-1 flex flex-col">
            {renderNav('desktop')}

            <div className="flex-1" />

            <div className="border-t border-white/[0.04] my-2 mx-2" />
            <button
              onClick={handleLogout}
              className="w-full text-left px-3 py-2 rounded-md text-sm text-txt-danger hover:bg-accent-rose/10 transition-colors"
            >
              {t('settings:nav.logOut')}
            </button>

            {instanceInfo && (
              <div className="px-3 pt-2">
                <SourceCodeLink sourceCodeUrl={instanceInfo.sourceCodeUrl} version={instanceInfo.version} commit={instanceInfo.commit} />
              </div>
            )}
          </div>
        </div>

        {/* Mobile: Tab list */}
        {isMobile && mobileView === 'tabs' && (
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {/* Mobile user card */}
            <div className="glass-bubble rounded-lg p-3 flex items-center gap-3">
              <Avatar
                src={user?.avatar}
                name={user?.displayName || user?.username || ''}
                size={36}
                userId={user?.id}
                avatarColor={user?.avatarColor}
              />
              <div className="min-w-0">
                <div className="text-sm font-medium text-txt-primary truncate">{user?.displayName || user?.username}</div>
                <div className="text-xs text-txt-tertiary truncate">@{user?.username}</div>
              </div>
            </div>

            <div className="glass-bubble rounded-lg p-2 space-y-0.5">
              {renderNav('mobile')}

              <div className="border-t border-white/[0.04] my-2 mx-2" />
              <button
                onClick={handleLogout}
                className="w-full text-left px-3 py-2 rounded-md text-sm text-txt-danger hover:bg-accent-rose/10 transition-colors"
              >
                {t('settings:nav.logOut')}
              </button>

              {instanceInfo && (
                <div className="px-3 pt-2">
                  <SourceCodeLink sourceCodeUrl={instanceInfo.sourceCodeUrl} version={instanceInfo.version} commit={instanceInfo.commit} />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Content area (desktop always, mobile only when viewing content) */}
        {(!isMobile || mobileView === 'content') && (
          <SettingsScrollContainer>
            <div className="px-6 max-w-[640px] mx-auto">
              {/* Mobile back button */}
              {isMobile && (
                <button
                  onClick={() => setMobileView('tabs')}
                  className="flex items-center gap-1.5 text-txt-tertiary hover:text-txt-secondary mb-4 text-sm"
                  aria-label={t('settings:nav.backToMenu')}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
                  </svg>
                  {t('common:labels.settings')}
                </button>
              )}
              <SettingsPanelSuspense key={tab}>
                {panels[tab]()}
              </SettingsPanelSuspense>
            </div>
          </SettingsScrollContainer>
        )}
      </div>
      </SettingsSectionsProvider>
    </Modal>
  );
}
