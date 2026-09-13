import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useSettingsSections } from '../../../hooks/useSettingsSections';
import { useInstanceUpdateBadge } from '../../../hooks/useInstanceUpdateBadge';
import type { SettingsSection } from '../SettingsSectionsContext';
import { SettingsTabBar } from '../SettingsTabBar';
import { GeneralPanel } from '../instanceSettingsPanels/GeneralPanel';
import { RegistrationPanel } from '../instanceSettingsPanels/RegistrationPanel';
import { FederationPanel } from '../instanceSettingsPanels/FederationPanel';
import { StreamingPanel } from '../instanceSettingsPanels/StreamingPanel';
import { StoragePanel } from '../instanceSettingsPanels/StoragePanel';
import { UsersPanel } from '../instanceSettingsPanels/UsersPanel';
import { UpdatesPanel } from '../instanceSettingsPanels/UpdatesPanel';
import { TelemetryPanel } from '../instanceSettingsPanels/TelemetryPanel';

type SubTab = 'general' | 'registration' | 'federation' | 'streaming' | 'storage' | 'users' | 'updates' | 'telemetry';

export function InstancePanel() {
  const { t } = useTranslation(['settings']);
  const fetchInstanceSettings = useSettingsStore((s) => s.fetchInstanceSettings);
  const fetchStreamingLimits = useSettingsStore((s) => s.fetchStreamingLimits);
  const fetchTelemetry = useSettingsStore((s) => s.fetchTelemetry);
  // Read here rather than in the telemetry panel alone: the invitation has to
  // be decided before that tab is ever opened, because it is what invites the
  // admin to open it.
  const telemetry = useSettingsStore((s) => s.telemetry);

  const [subTab, setSubTab] = useState<SubTab>('general');
  const [approvalCount, setApprovalCount] = useState(0);
  const updateBadge = useInstanceUpdateBadge();

  const sections = useMemo<SettingsSection[]>(() => [
    { id: 'general', label: t('settings:instance.tabs.general') },
    { id: 'registration', label: t('settings:instance.tabs.registration') },
    { id: 'federation', label: t('settings:instance.tabs.federation'), badgeCount: approvalCount },
    { id: 'streaming', label: t('settings:instance.tabs.streaming') },
    { id: 'storage', label: t('settings:instance.tabs.storage') },
    { id: 'users', label: t('settings:instance.tabs.users') },
    { id: 'updates', label: t('settings:instance.tabs.updates'), badgeDot: updateBadge },
    {
      id: 'telemetry',
      label: t('settings:instance.tabs.telemetry'),
      // Whenever the hello is not being sent, whether that is because nobody
      // has answered yet or because someone said no. `telemetry` is null while
      // the status is still loading, and an unknown state invites nothing.
      invite: telemetry !== null && telemetry.enabled !== true,
    },
  ], [approvalCount, updateBadge, telemetry, t]);

  const handleNavigate = useCallback((id: string) => {
    setSubTab(id as SubTab);
  }, []);

  // Register sections for sidebar sub-links (tab mode — no scroll-spy)
  useSettingsSections(sections, { onNavigate: handleNavigate, activeTab: subTab });

  useEffect(() => {
    fetchInstanceSettings();
    fetchStreamingLimits();
    // Failure leaves `telemetry` null, which shows the plain entry.
    void fetchTelemetry().catch(() => undefined);
  }, [fetchInstanceSettings, fetchStreamingLimits, fetchTelemetry]);

  return (
    <div className="space-y-4">
      <SettingsTabBar />

      {subTab === 'general' && <GeneralPanel />}
      {subTab === 'registration' && <RegistrationPanel />}
      {subTab === 'federation' && <FederationPanel onApprovalCountChange={setApprovalCount} />}
      {subTab === 'streaming' && <StreamingPanel />}
      {subTab === 'storage' && <StoragePanel />}
      {subTab === 'users' && <UsersPanel />}
      {subTab === 'updates' && <UpdatesPanel />}
      {subTab === 'telemetry' && <TelemetryPanel />}
    </div>
  );
}
