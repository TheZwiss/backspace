import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InstanceAdminSettings, InstanceStreamingLimits } from '@backspace/shared';
import { api } from '../api/client';
import { useSettingsStore } from './settingsStore';

const limits: InstanceStreamingLimits = {
  maxBitrateKbps: 20000,
  minBitrateKbps: 500,
  bitrateStepKbps: 500,
  allowedResolutions: [540, 720, 1080],
  allowedFramerates: [30, 45, 60],
  maxResolution: 1080,
  maxFramerate: 60,
  discoveryEnabled: true,
  directoryEnabled: false,
  bitrateMatrixOverrides: null,
  allowCustomBitrate: true,
};

const settings: InstanceAdminSettings = {
  instanceName: 'Workbench',
  registrationOpen: true,
  federatedRegistrationOpen: true,
  discoveryEnabled: true,
  maxUploadSizeMb: 100,
  federationRelayEnabled: true,
  federationRelayTtlDays: 30,
  defaultAutoRotateIntervalDays: 90,
  autoAcceptPeering: true,
  directoryEnabled: false,
  directoryLastPingAt: null,
  directoryLastError: null,
};

beforeEach(() => {
  useSettingsStore.setState({ streamingLimits: { ...limits }, instanceSettings: { ...settings } });
});

// DiscoveryPanel in the space settings reads both flags from streamingLimits,
// the one document any signed-in user may fetch, so a save in the admin panel
// has to land there too or the space switch keeps the stale state until reload.
describe('settings store directory mirror', () => {
  it('mirrors directoryEnabled into streamingLimits after an instance save', async () => {
    vi.spyOn(api.settings, 'updateInstance').mockResolvedValue({ ...settings, directoryEnabled: true });
    await useSettingsStore.getState().updateInstanceSettings({ directoryEnabled: true });
    expect(useSettingsStore.getState().instanceSettings?.directoryEnabled).toBe(true);
    expect(useSettingsStore.getState().streamingLimits?.directoryEnabled).toBe(true);
  });

  it('mirrors the server clearing the directory when discovery goes off', async () => {
    useSettingsStore.setState({
      streamingLimits: { ...limits, directoryEnabled: true },
      instanceSettings: { ...settings, directoryEnabled: true },
    });
    vi.spyOn(api.settings, 'updateInstance').mockResolvedValue({ ...settings, discoveryEnabled: false, directoryEnabled: false });
    await useSettingsStore.getState().updateInstanceSettings({ discoveryEnabled: false });
    expect(useSettingsStore.getState().streamingLimits).toMatchObject({ discoveryEnabled: false, directoryEnabled: false });
  });

  it('leaves the streaming limits alone while they are not loaded yet', async () => {
    useSettingsStore.setState({ streamingLimits: null });
    vi.spyOn(api.settings, 'updateInstance').mockResolvedValue({ ...settings, directoryEnabled: true });
    await useSettingsStore.getState().updateInstanceSettings({ directoryEnabled: true });
    expect(useSettingsStore.getState().streamingLimits).toBeNull();
  });
});
