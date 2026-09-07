import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '../api/client';
import { useSettingsStore } from './settingsStore';

const status = { enabled: null, id: null, lastDay: null, lastError: null };

beforeEach(() => {
  useSettingsStore.setState({ telemetry: null, telemetryPreview: null });
});

describe('settings store telemetry slice', () => {
  it('fetches the status', async () => {
    vi.spyOn(api.admin.telemetry, 'get').mockResolvedValue(status);
    await useSettingsStore.getState().fetchTelemetry();
    expect(useSettingsStore.getState().telemetry).toEqual(status);
  });
  it('sets enabled and stores the answer', async () => {
    const set = vi.spyOn(api.admin.telemetry, 'set').mockResolvedValue({ ...status, enabled: true, id: 'abc', lastDay: '2026-09-06' });
    await useSettingsStore.getState().setTelemetryEnabled(true);
    expect(set).toHaveBeenCalledWith(true);
    expect(useSettingsStore.getState().telemetry?.enabled).toBe(true);
  });
  it('fetches the preview', async () => {
    vi.spyOn(api.admin.telemetry, 'preview').mockResolvedValue({ schema: 1, instance: 'preview' } as never);
    await useSettingsStore.getState().fetchTelemetryPreview();
    expect(useSettingsStore.getState().telemetryPreview?.instance).toBe('preview');
  });
});
