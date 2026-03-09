import { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { GeneralPanel } from './instanceSettingsPanels/GeneralPanel';
import { StreamingPanel } from './instanceSettingsPanels/StreamingPanel';

export function InstanceSettingsModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const fetchInstanceSettings = useSettingsStore((s) => s.fetchInstanceSettings);
  const fetchStreamingLimits = useSettingsStore((s) => s.fetchStreamingLimits);

  const [tab, setTab] = useState<'general' | 'streaming'>('general');

  const isOpen = activeModal === 'instanceSettings';

  useEffect(() => {
    if (isOpen) {
      fetchInstanceSettings();
      fetchStreamingLimits();
    }
  }, [isOpen, fetchInstanceSettings, fetchStreamingLimits]);

  const tabClass = (t: typeof tab) =>
    `w-full text-left px-2.5 py-1.5 rounded text-sm transition-colors ${
      tab === t ? 'bg-interactive-selected text-txt-primary' : 'text-txt-tertiary hover:text-txt-secondary hover:bg-interactive-hover'
    }`;

  return (
    <Modal isOpen={isOpen} onClose={closeModal} title="Instance Settings" maxWidth="max-w-xl">
      <div className="flex gap-4 h-[min(460px,65vh)]">
        {/* Tabs */}
        <div className="w-32 flex-shrink-0 self-start z-10">
          <div className="glass-bubble rounded-lg p-1.5 space-y-0.5">
            <button onClick={() => setTab('general')} className={tabClass('general')}>
              General
            </button>
            <button onClick={() => setTab('streaming')} className={tabClass('streaming')}>
              Streaming
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 overflow-y-auto scrollbar-thin">
          {tab === 'general' && <GeneralPanel />}
          {tab === 'streaming' && <StreamingPanel />}
        </div>
      </div>
    </Modal>
  );
}
