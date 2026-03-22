import { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { useUIStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { AccountPanel } from './settingsPanels/AccountPanel';
import { VoicePanel } from './settingsPanels/VoicePanel';
import { PrivacyPanel } from './settingsPanels/PrivacyPanel';
import { ConnectionsPanel } from './settingsPanels/ConnectionsPanel';
import { InstancePanel } from './settingsPanels/InstancePanel';
import { SettingsSectionsProvider, useSettingsSectionsContext } from './SettingsSectionsContext';

type SettingsTab = 'account' | 'voice' | 'privacy' | 'connections' | 'instance';

function SidebarSubLinks() {
  const ctx = useSettingsSectionsContext();
  if (!ctx || ctx.sections.length === 0) return null;

  return (
    <div className="overflow-hidden">
      {ctx.sections.map((section) => (
        <button
          key={section.id}
          onClick={() => ctx.scrollToSection(section.id)}
          className={`w-full text-left pl-6 py-1 text-xs rounded-md transition-colors ${
            ctx.activeSection === section.id
              ? 'text-txt-primary'
              : 'text-txt-tertiary hover:text-txt-secondary'
          }`}
          aria-current={ctx.activeSection === section.id ? 'true' : undefined}
        >
          {section.label}
        </button>
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
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData);
  const closeModal = useUIStore((s) => s.closeModal);
  const isMobile = useUIStore((s) => s.isMobile);
  const isAdmin = useAuthStore((s) => s.user?.isAdmin);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const [tab, setTab] = useState<SettingsTab>('account');
  const [mobileView, setMobileView] = useState<'tabs' | 'content'>('tabs');

  const isOpen = activeModal === 'userSettings';

  // Deep-linking: read modalData.tab when opening
  useEffect(() => {
    if (isOpen) {
      const requested = modalData.tab as SettingsTab | undefined;
      if (requested && ['account', 'voice', 'privacy', 'connections', 'instance'].includes(requested)) {
        // Only allow instance tab for admins
        if (requested === 'instance' && !isAdmin) {
          setTab('account');
        } else {
          setTab(requested);
        }
      } else {
        setTab('account');
      }
      // On mobile, if deep-linking to a tab, show content directly
      setMobileView(requested ? 'content' : 'tabs');
    }
  }, [isOpen, modalData.tab, isAdmin]);

  const handleLogout = () => {
    logout();
    closeModal();
  };

  const tabClass = (t: SettingsTab) =>
    `w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
      tab === t ? 'bg-interactive-selected text-txt-primary font-medium' : 'text-txt-tertiary hover:text-txt-secondary hover:bg-interactive-hover'
    }`;

  const handleTabClick = (t: SettingsTab) => {
    setTab(t);
    if (isMobile) setMobileView('content');
  };

  return (
    <Modal isOpen={isOpen} onClose={closeModal} size="settings" mobileStyle="fullscreen">
      <SettingsSectionsProvider>
      <div className="flex h-full">
        {/* Desktop Sidebar */}
        <div className="hidden md:flex w-52 flex-shrink-0 flex-col p-4 gap-3">
          {/* User card */}
          <div className="glass-bubble rounded-lg p-3 flex items-center gap-3">
            <Avatar
              src={user?.avatar}
              name={user?.displayName || user?.username || ''}
              size={36}
              userId={user?.id}
            />
            <div className="min-w-0">
              <div className="text-sm font-medium text-txt-primary truncate">{user?.displayName || user?.username}</div>
              <div className="text-xs text-txt-tertiary truncate">@{user?.username}</div>
            </div>
          </div>

          {/* Nav list */}
          <div className="glass-bubble rounded-lg p-2 flex-1 flex flex-col">
            <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider px-3 py-1">User Settings</div>
            <button onClick={() => handleTabClick('account')} className={tabClass('account')}>Account</button>
            <button onClick={() => handleTabClick('voice')} className={tabClass('voice')}>Voice</button>
            <button onClick={() => handleTabClick('privacy')} className={tabClass('privacy')}>Privacy</button>

            <div className="border-t border-white/[0.04] my-2 mx-2" />
            <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider px-3 py-1">App Settings</div>
            <button onClick={() => handleTabClick('connections')} className={tabClass('connections')}>Connections</button>

            {isAdmin && (
              <>
                <div className="border-t border-white/[0.04] my-2 mx-2" />
                <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider px-3 py-1">Administration</div>
                <button onClick={() => handleTabClick('instance')} className={tabClass('instance')}>Instance</button>
                {tab === 'instance' && <SidebarSubLinks />}
              </>
            )}

            <div className="flex-1" />

            <div className="border-t border-white/[0.04] my-2 mx-2" />
            <button
              onClick={handleLogout}
              className="w-full text-left px-3 py-2 rounded-md text-sm text-txt-danger hover:bg-accent-rose/10 transition-colors"
            >
              Log Out
            </button>
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
              />
              <div className="min-w-0">
                <div className="text-sm font-medium text-txt-primary truncate">{user?.displayName || user?.username}</div>
                <div className="text-xs text-txt-tertiary truncate">@{user?.username}</div>
              </div>
            </div>

            <div className="glass-bubble rounded-lg p-2 space-y-0.5">
              <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider px-3 py-1">User Settings</div>
              <button onClick={() => handleTabClick('account')} className={tabClass('account')}>Account</button>
              <button onClick={() => handleTabClick('voice')} className={tabClass('voice')}>Voice</button>
              <button onClick={() => handleTabClick('privacy')} className={tabClass('privacy')}>Privacy</button>

              <div className="border-t border-white/[0.04] my-2 mx-2" />
              <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider px-3 py-1">App Settings</div>
              <button onClick={() => handleTabClick('connections')} className={tabClass('connections')}>Connections</button>

              {isAdmin && (
                <>
                  <div className="border-t border-white/[0.04] my-2 mx-2" />
                  <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider px-3 py-1">Administration</div>
                  <button onClick={() => handleTabClick('instance')} className={tabClass('instance')}>Instance</button>
                </>
              )}

              <div className="border-t border-white/[0.04] my-2 mx-2" />
              <button
                onClick={handleLogout}
                className="w-full text-left px-3 py-2 rounded-md text-sm text-txt-danger hover:bg-accent-rose/10 transition-colors"
              >
                Log Out
              </button>
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
                  aria-label="Back to settings menu"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
                  </svg>
                  Settings
                </button>
              )}
              {tab === 'account' && <AccountPanel />}
              {tab === 'voice' && <VoicePanel />}
              {tab === 'privacy' && <PrivacyPanel />}
              {tab === 'connections' && <ConnectionsPanel />}
              {tab === 'instance' && isAdmin && <InstancePanel />}
            </div>
          </SettingsScrollContainer>
        )}
      </div>
      </SettingsSectionsProvider>
    </Modal>
  );
}
