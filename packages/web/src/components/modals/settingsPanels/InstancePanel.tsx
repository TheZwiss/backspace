import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useSettingsSections } from '../../../hooks/useSettingsSections';
import type { SettingsSection } from '../SettingsSectionsContext';
import { SettingsTabBar } from '../SettingsTabBar';
import { GeneralPanel } from '../instanceSettingsPanels/GeneralPanel';
import { RegistrationPanel } from '../instanceSettingsPanels/RegistrationPanel';
import { FederationPanel } from '../instanceSettingsPanels/FederationPanel';
import { StreamingPanel } from '../instanceSettingsPanels/StreamingPanel';
import { StoragePanel } from '../instanceSettingsPanels/StoragePanel';
import { UsersPanel } from '../instanceSettingsPanels/UsersPanel';
import { translate } from '../../../i18n';

type SubTab = 'general' | 'registration' | 'federation' | 'streaming' | 'storage' | 'users';

export function InstancePanel() {
  const fetchInstanceSettings = useSettingsStore((s) => s.fetchInstanceSettings);
  const fetchStreamingLimits = useSettingsStore((s) => s.fetchStreamingLimits);

  const [subTab, setSubTab] = useState<SubTab>('general');
  const [approvalCount, setApprovalCount] = useState(0);

  const sections = useMemo<SettingsSection[]>(() => [
    { id: 'general', label: translate('runtime.properties.InstancePanel.general') },
    { id: 'registration', label: translate('runtime.properties.InstancePanel.registration') },
    { id: 'federation', label: translate('runtime.properties.InstancePanel.federation'), badgeCount: approvalCount },
    { id: 'streaming', label: translate('runtime.properties.InstancePanel.streaming') },
    { id: 'storage', label: translate('runtime.properties.InstancePanel.storage') },
    { id: 'users', label: translate('runtime.properties.InstancePanel.users') },
  ], [approvalCount]);

  const handleNavigate = useCallback((id: string) => {
    setSubTab(id as SubTab);
  }, []);

  // Register sections for sidebar sub-links (tab mode — no scroll-spy)
  useSettingsSections(sections, { onNavigate: handleNavigate, activeTab: subTab });

  useEffect(() => {
    fetchInstanceSettings();
    fetchStreamingLimits();
  }, [fetchInstanceSettings, fetchStreamingLimits]);

  return (
    <div className="space-y-4">
      <SettingsTabBar />

      {subTab === "general" && <GeneralPanel />}
      {subTab === "registration" && <RegistrationPanel />}
      {subTab === "federation" && <FederationPanel onApprovalCountChange={setApprovalCount} />}
      {subTab === "streaming" && <StreamingPanel />}
      {subTab === "storage" && <StoragePanel />}
      {subTab === "users" && <UsersPanel />}
    </div>
  );
}
