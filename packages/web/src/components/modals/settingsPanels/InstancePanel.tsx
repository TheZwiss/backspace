import { useEffect } from 'react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useSettingsSections } from '../../../hooks/useSettingsSections';
import { GeneralPanel } from '../instanceSettingsPanels/GeneralPanel';
import { StreamingPanel } from '../instanceSettingsPanels/StreamingPanel';
import { StoragePanel } from '../instanceSettingsPanels/StoragePanel';
import { UsersPanel } from '../instanceSettingsPanels/UsersPanel';

const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'streaming', label: 'Streaming' },
  { id: 'storage', label: 'Storage' },
  { id: 'users', label: 'Users' },
] as const;

export function InstancePanel() {
  const fetchInstanceSettings = useSettingsStore((s) => s.fetchInstanceSettings);
  const fetchStreamingLimits = useSettingsStore((s) => s.fetchStreamingLimits);
  const { sectionRef } = useSettingsSections([...SECTIONS]);

  useEffect(() => {
    fetchInstanceSettings();
    fetchStreamingLimits();
  }, [fetchInstanceSettings, fetchStreamingLimits]);

  return (
    <div className="space-y-0">
      {/* General */}
      <h3 ref={sectionRef('general')} className="text-base font-semibold text-txt-primary mb-4">
        General
      </h3>
      <GeneralPanel />

      <div className="border-t border-white/[0.04] my-6" />

      {/* Streaming */}
      <h3 ref={sectionRef('streaming')} className="text-base font-semibold text-txt-primary mb-4">
        Streaming
      </h3>
      <StreamingPanel />

      <div className="border-t border-white/[0.04] my-6" />

      {/* Storage */}
      <h3 ref={sectionRef('storage')} className="text-base font-semibold text-txt-primary mb-4">
        Storage
      </h3>
      <StoragePanel />

      <div className="border-t border-white/[0.04] my-6" />

      {/* Users */}
      <h3 ref={sectionRef('users')} className="text-base font-semibold text-txt-primary mb-4">
        Users
      </h3>
      <UsersPanel />
    </div>
  );
}
