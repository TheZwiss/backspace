import { useState, useEffect } from 'react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { GeneralPanel } from '../instanceSettingsPanels/GeneralPanel';
import { StreamingPanel } from '../instanceSettingsPanels/StreamingPanel';

type SubTab = 'general' | 'streaming';

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
      {/* Sub-tab switcher */}
      <div className="flex gap-1 p-1 bg-white/[0.02] rounded-full w-fit">
        <button onClick={() => setSubTab('general')} className={pillClass('general')}>
          General
        </button>
        <button onClick={() => setSubTab('streaming')} className={pillClass('streaming')}>
          Streaming
        </button>
      </div>

      {/* Content */}
      {subTab === 'general' && <GeneralPanel />}
      {subTab === 'streaming' && <StreamingPanel />}
    </div>
  );
}
