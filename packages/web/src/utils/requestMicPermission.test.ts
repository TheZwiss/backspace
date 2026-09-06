import { beforeEach, describe, expect, it, vi } from 'vitest';

const audio = vi.hoisted(() => ({
  clearInputDenial: vi.fn(), resumeContext: vi.fn(), setInputDevice: vi.fn(),
}));
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => audio } }));
vi.mock('../hooks/useWebSocket', () => ({ wsSend: vi.fn() }));

import { requestMicPermission } from './voice';
import { useVoiceStore } from '../stores/voiceStore';

beforeEach(() => {
  vi.clearAllMocks();
  useVoiceStore.setState({ micPermissionDenied: true });
});

describe('requestMicPermission', () => {
  it('does not report success when capture was cancelled while permission was pending', async () => {
    let finish!: (stream: null) => void;
    audio.setInputDevice.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = requestMicPermission();
    await vi.waitFor(() => expect(audio.setInputDevice).toHaveBeenCalled());
    finish(null);
    expect(await pending).toBe(false);
    expect(useVoiceStore.getState().micPermissionDenied).toBe(true);
  });

  it('clears the denial when capture is acquired', async () => {
    audio.setInputDevice.mockResolvedValueOnce({ getTracks: () => [] });
    expect(await requestMicPermission()).toBe(true);
    expect(useVoiceStore.getState().micPermissionDenied).toBe(false);
  });
});
