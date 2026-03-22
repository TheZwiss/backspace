import { useState, useEffect } from 'react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { GeneralPanel } from '../instanceSettingsPanels/GeneralPanel';
import { StreamingPanel } from '../instanceSettingsPanels/StreamingPanel';
import { StoragePanel } from '../instanceSettingsPanels/StoragePanel';
import { UsersPanel } from '../instanceSettingsPanels/UsersPanel';

type SubTab = 'general' | 'streaming' | 'storage' | 'users';

export function InstancePanel() {
  const fetchInstanceSettings = useSettingsStore((s) => s.fetchInstanceSettings);
  const fetchStreamingLimits = useSettingsStore((s) => s.fetchStreamingLimits);

  const [subTab, setSubTab] = useState<SubTab>('general');

  useEffect(() => {
    fetchInstanceSettings();
    fetchStreamingLimits();
  }, [fetchInstanceSettings, fetchStreamingLimits]);

  const pillClass = (t: SubTab) =>
    `px-3 py-1 text-sm rounded-full transition-colors ${
      subTab === t
        ? 'bg-interactive-selected text-txt-primary'
        : 'text-txt-tertiary hover:text-txt-secondary hover:bg-interactive-hover'
    }`;

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-txt-primary mb-6">Instance</h2>
      {/* Sub-tab switcher */}
      <div className="flex gap-1 p-1 bg-white/[0.02] rounded-full w-fit">
        <button onClick={() => setSubTab('general')} className={pillClass('general')}>
          General
        </button>
        <button onClick={() => setSubTab('streaming')} className={pillClass('streaming')}>
          Streaming
        </button>
        <button onClick={() => setSubTab('storage')} className={pillClass('storage')}>
          Storage
        </button>
        <button onClick={() => setSubTab('users')} className={pillClass('users')}>
          Users
        </button>
      </div>

      {/* Content */}
      {subTab === 'general' && <GeneralPanel />}
      {subTab === 'streaming' && <StreamingPanel />}
      {subTab === 'storage' && <StoragePanel />}
      {subTab === 'users' && <UsersPanel />}
    </div>
  );
}
