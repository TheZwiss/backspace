import React from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { AccountPanel } from '../modals/settingsPanels/AccountPanel';
import { VoicePanel } from '../modals/settingsPanels/VoicePanel';
import { ConnectionsPanel } from '../modals/settingsPanels/ConnectionsPanel';
import { PrivacyPanel } from '../modals/settingsPanels/PrivacyPanel';

interface MobileSettingsScreenProps {
  initialPanel?: string;
}

const panelConfig: Record<string, { title: string; component: React.ReactNode }> = {
  account: { title: 'Account', component: <AccountPanel /> },
  voice: { title: 'Voice & Video', component: <VoicePanel /> },
  privacy: { title: 'Privacy', component: <PrivacyPanel /> },
  connections: { title: 'Connections', component: <ConnectionsPanel /> },
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
  instance: (
    <svg className="w-5 h-5 text-txt-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z" />
    </svg>
  ),
};

export function MobileSettingsScreen({ initialPanel }: MobileSettingsScreenProps) {
  const popMobileScreen = useUIStore((s) => s.popMobileScreen);
  const pushMobileScreen = useUIStore((s) => s.pushMobileScreen);
  const isAdmin = useAuthStore((s) => s.user?.isAdmin);

  // If initialPanel is set, render that panel directly
  if (initialPanel) {
    const panel = panelConfig[initialPanel];
    if (!panel) return null;
    if (initialPanel === 'instance' && !isAdmin) return null;

    return (
      <div className="flex flex-col h-full bg-surface-base">
        <header className="h-12 flex items-center gap-2 px-3 border-b border-border-soft shrink-0">
          <button onClick={popMobileScreen} className="w-8 h-8 flex items-center justify-center text-txt-secondary hover:text-txt-primary">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
          </button>
          <h1 className="text-sm font-semibold text-txt-primary">{panel.title}</h1>
        </header>
        <div className="flex-1 overflow-y-auto p-4">
          {panel.component}
        </div>
      </div>
    );
  }

  // Settings section list
  const sections = [
    { id: 'account', label: 'Account' },
    { id: 'voice', label: 'Voice & Video' },
    { id: 'privacy', label: 'Privacy' },
    { id: 'connections', label: 'Connections' },
    ...(isAdmin ? [{ id: 'instance', label: 'Instance' }] : []),
  ];

  return (
    <div className="flex flex-col h-full bg-surface-base">
      <header className="h-12 flex items-center gap-2 px-3 border-b border-border-soft shrink-0">
        <button onClick={popMobileScreen} className="w-8 h-8 flex items-center justify-center text-txt-secondary hover:text-txt-primary">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
        <h1 className="text-sm font-semibold text-txt-primary">Settings</h1>
      </header>
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
