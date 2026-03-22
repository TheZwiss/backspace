import { useState, useEffect, useCallback } from 'react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useSettingsSections } from '../../../hooks/useSettingsSections';
import type { SettingsSection } from '../SettingsSectionsContext';
import { GeneralPanel } from '../instanceSettingsPanels/GeneralPanel';
import { StreamingPanel } from '../instanceSettingsPanels/StreamingPanel';
import { StoragePanel } from '../instanceSettingsPanels/StoragePanel';
import { UsersPanel } from '../instanceSettingsPanels/UsersPanel';

type SubTab = 'general' | 'streaming' | 'storage' | 'users';

const SECTIONS: SettingsSection[] = [
  { id: 'general', label: 'General' },
  { id: 'streaming', label: 'Streaming' },
  { id: 'storage', label: 'Storage' },
  { id: 'users', label: 'Users' },
];

export function InstancePanel() {
  const fetchInstanceSettings = useSettingsStore((s) => s.fetchInstanceSettings);
  const fetchStreamingLimits = useSettingsStore((s) => s.fetchStreamingLimits);

  const [subTab, setSubTab] = useState<SubTab>('general');

  const handleNavigate = useCallback((id: string) => {
    setSubTab(id as SubTab);
  }, []);

  // Register sections for sidebar sub-links (tab mode — no scroll-spy)
  useSettingsSections(SECTIONS, { onNavigate: handleNavigate, activeTab: subTab });

  useEffect(() => {
    fetchInstanceSettings();
    fetchStreamingLimits();
  }, [fetchInstanceSettings, fetchStreamingLimits]);

  const tabPillClass = (t: SubTab) =>
    `px-3 py-1.5 text-sm rounded-md transition-colors ${
      subTab === t
        ? 'text-txt-primary font-medium border-b-2 border-accent-primary'
        : 'text-txt-tertiary hover:text-txt-secondary'
    }`;

  return (
    <div className="space-y-4">
      {/* Top tab bar */}
      <div className="flex gap-1 border-b border-white/[0.04] pb-0">
        {SECTIONS.map((s) => (
          <button key={s.id} onClick={() => setSubTab(s.id as SubTab)} className={tabPillClass(s.id as SubTab)}>
            {s.label}
          </button>
        ))}
      </div>

      {subTab === 'general' && <GeneralPanel />}
      {subTab === 'streaming' && <StreamingPanel />}
      {subTab === 'storage' && <StoragePanel />}
      {subTab === 'users' && <UsersPanel />}
    </div>
  );
}
