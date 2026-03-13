import { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { AccountPanel } from './settingsPanels/AccountPanel';
import { VoicePanel } from './settingsPanels/VoicePanel';
import { PrivacyPanel } from './settingsPanels/PrivacyPanel';
import { ConnectionsPanel } from './settingsPanels/ConnectionsPanel';
import { InstancePanel } from './settingsPanels/InstancePanel';

type SettingsTab = 'account' | 'voice' | 'privacy' | 'connections' | 'instance';

export function UserSettingsModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData);
  const closeModal = useUIStore((s) => s.closeModal);
  const isAdmin = useAuthStore((s) => s.user?.isAdmin);
  const logout = useAuthStore((s) => s.logout);

  const [tab, setTab] = useState<SettingsTab>('account');

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
    }
  }, [isOpen, modalData.tab, isAdmin]);

  const handleLogout = () => {
    logout();
    closeModal();
  };

  const tabClass = (t: SettingsTab) =>
    `w-full text-left px-2.5 py-1.5 rounded text-sm transition-colors ${
      tab === t ? 'bg-interactive-selected text-txt-primary' : 'text-txt-tertiary hover:text-txt-secondary hover:bg-interactive-hover'
    }`;

  return (
    <Modal isOpen={isOpen} onClose={closeModal} title="Settings" maxWidth="max-w-2xl">
      <div className="flex gap-4 h-[min(520px,70vh)]">
        {/* Sidebar */}
        <div className="w-32 flex-shrink-0 flex flex-col gap-2">
          <div className="glass-bubble rounded-lg p-1.5 space-y-0.5">
            <button onClick={() => setTab('account')} className={tabClass('account')}>
              Account
            </button>
            <button onClick={() => setTab('voice')} className={tabClass('voice')}>
              Voice
            </button>
            <button onClick={() => setTab('privacy')} className={tabClass('privacy')}>
              Privacy
            </button>
            <button onClick={() => setTab('connections')} className={tabClass('connections')}>
              Connections
            </button>
            {isAdmin && (
              <button onClick={() => setTab('instance')} className={tabClass('instance')}>
                Instance
              </button>
            )}
          </div>
          <div className="glass-bubble rounded-lg p-1.5">
            <button
              onClick={handleLogout}
              className="w-full px-2.5 py-1.5 rounded text-sm text-txt-danger hover:bg-accent-rose/10 transition-colors text-left"
            >
              Log Out
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 overflow-y-auto scrollbar-thin">
          {tab === 'account' && <AccountPanel />}
          {tab === 'voice' && <VoicePanel />}
          {tab === 'privacy' && <PrivacyPanel />}
          {tab === 'connections' && <ConnectionsPanel />}
          {tab === 'instance' && isAdmin && <InstancePanel />}
        </div>
      </div>
    </Modal>
  );
}
