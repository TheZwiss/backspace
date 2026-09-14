import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '../api/client';
import { useSettingsStore } from './settingsStore';
import { ASK_STORAGE_KEY, recordDismissal } from '../utils/telemetryAsk';

const status = { enabled: null, id: null, lastDay: null, lastError: null, askDue: true };

beforeEach(() => {
  useSettingsStore.setState({ telemetry: null, telemetryPreview: null });
  localStorage.removeItem(ASK_STORAGE_KEY);
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
  it('forgets this browser\'s snooze once an answer is stored, from the panel as much as from the modal', async () => {
    recordDismissal(localStorage, Date.now());
    vi.spyOn(api.admin.telemetry, 'set').mockResolvedValue({ ...status, enabled: false, askDue: false });
    await useSettingsStore.getState().setTelemetryEnabled(false);
    expect(localStorage.getItem(ASK_STORAGE_KEY)).toBeNull();
  });
  it('keeps the snooze when the answer could not be stored', async () => {
    recordDismissal(localStorage, Date.now());
    vi.spyOn(api.admin.telemetry, 'set').mockRejectedValue(new Error('offline'));
    await expect(useSettingsStore.getState().setTelemetryEnabled(false)).rejects.toThrow('offline');
    expect(localStorage.getItem(ASK_STORAGE_KEY)).not.toBeNull();
  });
  it('fetches the preview', async () => {
    vi.spyOn(api.admin.telemetry, 'preview').mockResolvedValue({ schema: 1, instance: 'preview' } as never);
    await useSettingsStore.getState().fetchTelemetryPreview();
    expect(useSettingsStore.getState().telemetryPreview?.instance).toBe('preview');
  });
});
