import React from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { AccountPanel } from '../modals/settingsPanels/AccountPanel';
import { VoicePanel } from '../modals/settingsPanels/VoicePanel';
import { ConnectionsPanel } from '../modals/settingsPanels/ConnectionsPanel';
import { PrivacyPanel } from '../modals/settingsPanels/PrivacyPanel';
import { KeybindsPanel } from '../modals/settingsPanels/KeybindsPanel';
import { DesktopPanel } from '../modals/settingsPanels/DesktopPanel';
import { LanguagePanel } from '../modals/settingsPanels/LanguagePanel';
import { MobileScreenHeader } from './MobileScreenHeader';
import { TransferIndicator } from './TransferIndicator';
import { isElectron } from '../../platform/platform';
import { useTranslation } from 'react-i18next';
import { translate } from '../../i18n';

interface MobileSettingsScreenProps {
  initialPanel?: string;
}

const panelConfig: Record<string, { titleKey: string; component: React.ReactNode }> = {
  account: { titleKey: 'common.account', component: <AccountPanel /> },
  voice: { titleKey: 'common.voiceVideo', component: <VoicePanel /> },
  privacy: { titleKey: 'common.privacy', component: <PrivacyPanel /> },
  connections: { titleKey: 'common.connections', component: <ConnectionsPanel /> },
  language: { titleKey: 'language.label', component: <LanguagePanel /> },
  keybinds: { titleKey: 'common.keybinds', component: <KeybindsPanel /> },
  desktop: { titleKey: 'common.desktop', component: <DesktopPanel /> },
};

const sectionIcons: Record<string, React.ReactNode> = {
  account: (
    <svg className="w-5 h-5 text-txt-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
    </svg>
  ),
  voice: (
    <svg className="w-5 h-5 text-txt-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
    </svg>
  ),
  privacy: (
    <svg className="w-5 h-5 text-txt-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
    </svg>
  ),
  connections: (
    <svg className="w-5 h-5 text-txt-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-4.122a4.5 4.5 0 00-6.364-6.364L4.5 6.325a4.5 4.5 0 001.242 7.244" />
    </svg>
  ),
  language: (
    <svg className="w-5 h-5 text-txt-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 21l5.25-11.25L21 21m-9-3h7.5M3 5.25h7.5M6.75 3v2.25m2.625 0C8.469 9.25 6 12 3 13.5m1.5-6c1.125 2.25 3 4.125 5.25 5.25" />
    </svg>
  ),
  instance: (
    <svg className="w-5 h-5 text-txt-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z" />
    </svg>
  ),
  keybinds: (
    <svg className="w-5 h-5 text-txt-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 7.125C2.25 6.504 2.754 6 3.375 6h6c.621 0 1.125.504 1.125 1.125v3.75c0 .621-.504 1.125-1.125 1.125h-6a1.125 1.125 0 01-1.125-1.125v-3.75zM14.25 8.625c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v8.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 01-1.125-1.125v-8.25zM3.75 16.125c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v2.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 01-1.125-1.125v-2.25z" />
    </svg>
  ),
  desktop: (
    <svg className="w-5 h-5 text-txt-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a9 9 0 01-9 9m0 0a9 9 0 01-9-9" />
    </svg>
  ),
};

export function MobileSettingsScreen({ initialPanel }: MobileSettingsScreenProps) {
  const { t } = useTranslation();
  const pushMobileScreen = useUIStore((s) => s.pushMobileScreen);
  const isAdmin = useAuthStore((s) => s.user?.isAdmin);

  // If initialPanel is set, render that panel directly
  if (initialPanel) {
    const panel = panelConfig[initialPanel];
    if (!panel) return null;
    if (initialPanel === 'instance' && !isAdmin) return null;

    return (
      <div className="flex flex-col h-full bg-surface-base">
        <MobileScreenHeader title={t(panel.titleKey)} rightActions={<TransferIndicator />} />
        <div className="flex-1 overflow-y-auto p-4">
          {panel.component}
        </div>
      </div>
    );
  }

  // Settings section list. Desktop and Keybinds are Electron-only — global
  // shortcuts and auto-launch/update controls are meaningless on the iOS PWA
  // and on web mobile. The desktop UserSettings modal also gates Desktop on
  // isElectron(); we mirror that here, plus apply the same gate to Keybinds
  // since the panel's only-when-tab-focused web fallback isn't a useful
  // mobile feature (no global hooks, no recording flow on touch keyboards).
  const sections = [
    { id: 'account', label: t('common.account') },
    { id: 'voice', label: t('common.voiceVideo') },
    { id: 'privacy', label: t('common.privacy') },
    { id: 'connections', label: t('common.connections') },
    { id: 'language', label: t('language.label') },
    ...(isElectron() ? [{ id: 'keybinds', label: t('common.keybinds') }, { id: 'desktop', label: t('common.desktop') }] : []),
    ...(isAdmin ? [{ id: 'instance', label: t('common.instance') }] : []),
  ];

  return (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title={t("common.settings")} rightActions={<TransferIndicator />} />
      <div className="flex-1 overflow-y-auto">
        {sections.map((section) => (
          <button
            key={section.id}
            onClick={() => pushMobileScreen(`settings-${section.id}`)}
            className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-interactive-hover text-left transition-colors"
          >
            {sectionIcons[section.id]}
            <span className="text-sm text-txt-primary flex-1">{section.label}</span>
            <svg className="w-4 h-4 text-txt-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}
