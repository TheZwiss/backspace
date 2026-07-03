import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAudioDevices } from './useAudioDevices';

type Listener = () => void;

function setupMediaDevicesMock(opts: {
  permissionState?: 'granted' | 'prompt' | 'denied';
  devices?: MediaDeviceInfo[];
  permissionThrows?: boolean;
} = {}) {
  const listeners = new Set<Listener>();
  const permState = opts.permissionState ?? 'granted';
  const devices = opts.devices ?? [
    { deviceId: 'mic-1', kind: 'audioinput', label: 'Built-in Mic', groupId: 'g1', toJSON: () => ({}) } as MediaDeviceInfo,
    { deviceId: 'mic-2', kind: 'audioinput', label: 'USB Headset', groupId: 'g2', toJSON: () => ({}) } as MediaDeviceInfo,
    { deviceId: 'spk-1', kind: 'audiooutput', label: 'Built-in Speakers', groupId: 'g1', toJSON: () => ({}) } as MediaDeviceInfo,
    { deviceId: 'spk-2', kind: 'audiooutput', label: 'USB Headset', groupId: 'g2', toJSON: () => ({}) } as MediaDeviceInfo,
  ];

  const mediaDevices = {
    enumerateDevices: vi.fn().mockResolvedValue(devices),
    addEventListener: (_evt: string, l: Listener) => { listeners.add(l); },
    removeEventListener: (_evt: string, l: Listener) => { listeners.delete(l); },
    getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
  };
  Object.defineProperty(navigator, 'mediaDevices', { value: mediaDevices, configurable: true });

  const permStatus = {
    state: permState,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const permissions = {
    query: opts.permissionThrows
      ? vi.fn().mockRejectedValue(new Error('not supported'))
      : vi.fn().mockResolvedValue(permStatus),
  };
  Object.defineProperty(navigator, 'permissions', { value: permissions, configurable: true });

  return { listeners, mediaDevices, permissions, permStatus, fireDeviceChange: () => listeners.forEach(l => l()) };
}

describe('useAudioDevices', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('starts in unknown state, transitions to granted, enumerates inputs and outputs', async () => {
    const m = setupMediaDevicesMock({ permissionState: 'granted' });
    const { result } = renderHook(() => useAudioDevices());

    expect(result.current.permState).toBe('unknown');
    await waitFor(() => expect(result.current.permState).toBe('granted'));
    await waitFor(() => expect(result.current.inputs.length).toBe(2));
    expect(result.current.outputs.length).toBe(2);
    expect(result.current.inputs[0].deviceId).toBe('mic-1');
  });

  it('returns prompt state when permission is prompt', async () => {
    setupMediaDevicesMock({ permissionState: 'prompt' });
    const { result } = renderHook(() => useAudioDevices());
    await waitFor(() => expect(result.current.permState).toBe('prompt'));
    expect(result.current.inputs).toEqual([]);
    expect(result.current.outputs).toEqual([]);
  });

  it('returns denied state when permission is denied', async () => {
    setupMediaDevicesMock({ permissionState: 'denied' });
    const { result } = renderHook(() => useAudioDevices());
    await waitFor(() => expect(result.current.permState).toBe('denied'));
  });

  it('falls back to prompt when permissions.query throws', async () => {
    setupMediaDevicesMock({ permissionThrows: true });
    const { result } = renderHook(() => useAudioDevices());
    await waitFor(() => expect(result.current.permState).toBe('prompt'));
  });

  it('refreshes lists on devicechange', async () => {
    const m = setupMediaDevicesMock({ permissionState: 'granted' });
    const { result } = renderHook(() => useAudioDevices());
    await waitFor(() => expect(result.current.inputs.length).toBe(2));

    m.mediaDevices.enumerateDevices.mockResolvedValueOnce([
      { deviceId: 'mic-1', kind: 'audioinput', label: 'Built-in Mic', groupId: 'g1', toJSON: () => ({}) } as MediaDeviceInfo,
    ]);
    act(() => { m.fireDeviceChange(); });
    await waitFor(() => expect(result.current.inputs.length).toBe(1));
  });

  it('deduplicates devices by deviceId', async () => {
    setupMediaDevicesMock({
      permissionState: 'granted',
      devices: [
        { deviceId: 'mic-1', kind: 'audioinput', label: 'A', groupId: 'g1', toJSON: () => ({}) } as MediaDeviceInfo,
        { deviceId: 'mic-1', kind: 'audioinput', label: 'A', groupId: 'g1', toJSON: () => ({}) } as MediaDeviceInfo,
        { deviceId: 'spk-1', kind: 'audiooutput', label: 'B', groupId: 'g1', toJSON: () => ({}) } as MediaDeviceInfo,
      ],
    });
    const { result } = renderHook(() => useAudioDevices());
    await waitFor(() => expect(result.current.permState).toBe('granted'));
    expect(result.current.inputs.length).toBe(1);
    expect(result.current.outputs.length).toBe(1);
  });

  it('requestPermission fires getUserMedia({audio:true}) and stops the stream', async () => {
    const m = setupMediaDevicesMock({ permissionState: 'prompt' });
    const { result } = renderHook(() => useAudioDevices());
    await waitFor(() => expect(result.current.permState).toBe('prompt'));

    await act(async () => { await result.current.requestPermission(); });
    expect(m.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
  });

  it('builds display labels with disambiguation suffix for duplicate names', async () => {
    setupMediaDevicesMock({
      permissionState: 'granted',
      devices: [
        { deviceId: 'mic-1', kind: 'audioinput', label: 'USB Audio', groupId: 'g1', toJSON: () => ({}) } as MediaDeviceInfo,
        { deviceId: 'mic-2', kind: 'audioinput', label: 'USB Audio', groupId: 'g2', toJSON: () => ({}) } as MediaDeviceInfo,
        { deviceId: 'mic-3', kind: 'audioinput', label: '', groupId: 'g3', toJSON: () => ({}) } as MediaDeviceInfo,
      ],
    });
    const { result } = renderHook(() => useAudioDevices());
    await waitFor(() => expect(result.current.inputs.length).toBe(3));
    expect(result.current.inputLabels.get('mic-1')).toBe('USB Audio (1)');
    expect(result.current.inputLabels.get('mic-2')).toBe('USB Audio (2)');
    expect(result.current.inputLabels.get('mic-3')).toBe('Microphone 3');
  });
});
