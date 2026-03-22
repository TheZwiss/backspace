import { useEffect } from 'react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useSettingsSections } from '../../../hooks/useSettingsSections';
import type { SettingsSection } from '../SettingsSectionsContext';
import { GeneralPanel } from '../instanceSettingsPanels/GeneralPanel';
import { StreamingPanel } from '../instanceSettingsPanels/StreamingPanel';
import { StoragePanel } from '../instanceSettingsPanels/StoragePanel';
import { UsersPanel } from '../instanceSettingsPanels/UsersPanel';

const SECTIONS: SettingsSection[] = [
  { id: 'general', label: 'General' },
  { id: 'streaming', label: 'Streaming' },
  { id: 'storage', label: 'Storage' },
  { id: 'users', label: 'Users' },
];

export function InstancePanel() {
  const fetchInstanceSettings = useSettingsStore((s) => s.fetchInstanceSettings);
  const fetchStreamingLimits = useSettingsStore((s) => s.fetchStreamingLimits);
  const { sectionRef } = useSettingsSections(SECTIONS);

  useEffect(() => {
    fetchInstanceSettings();
    fetchStreamingLimits();
  }, [fetchInstanceSettings, fetchStreamingLimits]);

  return (
    <div>
      {/* General */}
      <h3 ref={sectionRef('general')} className="text-lg font-semibold text-txt-primary mb-1">
        General
      </h3>
      <p className="text-sm text-txt-tertiary mb-5">Configure your Backspace instance. These settings affect all users.</p>
      <GeneralPanel />

      <div className="border-t border-white/[0.04] my-10" />

      {/* Streaming */}
      <h3 ref={sectionRef('streaming')} className="text-lg font-semibold text-txt-primary mb-1">
        Streaming
      </h3>
      <p className="text-sm text-txt-tertiary mb-5">These limits apply to all users on this instance. Users can pick values within these bounds.</p>
      <StreamingPanel />

      <div className="border-t border-white/[0.04] my-10" />

      {/* Storage */}
      <h3 ref={sectionRef('storage')} className="text-lg font-semibold text-txt-primary mb-1">
        Storage
      </h3>
      <p className="text-sm text-txt-tertiary mb-5">Monitor file storage usage and clean up orphaned files.</p>
      <StoragePanel />

      <div className="border-t border-white/[0.04] my-10" />

      {/* Users */}
      <h3 ref={sectionRef('users')} className="text-lg font-semibold text-txt-primary mb-1">
        Users
      </h3>
      <p className="text-sm text-txt-tertiary mb-5">View and manage user accounts on this instance.</p>
      <UsersPanel />
    </div>
  );
}
