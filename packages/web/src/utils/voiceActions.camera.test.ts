import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));
vi.mock('../hooks/useWebSocket', () => ({ wsSend: vi.fn() }));
vi.mock('../stores/instanceStore', async () => {
  const { create } = await import('zustand');
  return { useInstanceStore: create<{ instances: unknown[] }>()(() => ({ instances: [] })) };
});
const setCameraEnabled = vi.fn();
const room = { localParticipant: { setCameraEnabled } };
vi.mock('../hooks/useLiveKit', () => ({ getActiveRoom: vi.fn(() => room) }));
vi.mock('./voice', () => ({ broadcastVoiceStatus: vi.fn(), broadcastDeafenViaLiveKit: vi.fn() }));
vi.mock('./camera', () => ({
  buildCameraOptions: vi.fn(() => ({ publish: { simulcast: true } })),
  buildCameraCaptureOptions: vi.fn(async () => ({ capture: { frameRate: 30 }, fitted: { width: 1280, height: 720, frameRate: 30 } })),
}));

import { handleCameraAction } from './voiceActions';
import { buildCameraCaptureOptions } from './camera';
import { useVoiceStore } from '../stores/voiceStore';

describe('handleCameraAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCameraEnabled.mockReset();
    useVoiceStore.setState({ isCameraOn: false, isCameraStarting: false, cameraDeviceId: null });
  });

  it('starts without measuring the camera and flips the state once published', async () => {
    setCameraEnabled.mockResolvedValue(undefined);
    await handleCameraAction();
    expect(buildCameraCaptureOptions).toHaveBeenCalledWith(expect.anything(), null, { measure: false });
    expect(setCameraEnabled).toHaveBeenCalledTimes(1);
    expect(useVoiceStore.getState().isCameraOn).toBe(true);
    expect(useVoiceStore.getState().isCameraStarting).toBe(false);
  });

  it('shows the starting state while the camera is being published', async () => {
    let finish: () => void = () => {};
    setCameraEnabled.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const pending = handleCameraAction();
    await vi.waitFor(() => expect(useVoiceStore.getState().isCameraStarting).toBe(true));
    expect(useVoiceStore.getState().isCameraOn).toBe(false);
    finish();
    await pending;
    expect(useVoiceStore.getState().isCameraStarting).toBe(false);
    expect(useVoiceStore.getState().isCameraOn).toBe(true);
  });

  it('ignores a second click while a start is in flight', async () => {
    let finish: () => void = () => {};
    setCameraEnabled.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const first = handleCameraAction();
    await vi.waitFor(() => expect(useVoiceStore.getState().isCameraStarting).toBe(true));
    await handleCameraAction();
    expect(setCameraEnabled).toHaveBeenCalledTimes(1);
    finish();
    await first;
    expect(useVoiceStore.getState().isCameraOn).toBe(true);
  });

  it('clears the starting state when publishing fails, leaving the camera off', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setCameraEnabled.mockRejectedValue(new Error('denied'));
    await handleCameraAction();
    expect(useVoiceStore.getState().isCameraStarting).toBe(false);
    expect(useVoiceStore.getState().isCameraOn).toBe(false);
  });

  it('turning the camera off is immediate and never shows the starting state', async () => {
    useVoiceStore.setState({ isCameraOn: true });
    setCameraEnabled.mockResolvedValue(undefined);
    await handleCameraAction();
    expect(setCameraEnabled).toHaveBeenCalledWith(false);
    expect(useVoiceStore.getState().isCameraOn).toBe(false);
    expect(useVoiceStore.getState().isCameraStarting).toBe(false);
  });
});
