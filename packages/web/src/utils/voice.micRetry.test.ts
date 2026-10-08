import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setInputDevice = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useWebSocket', () => ({ wsSend: vi.fn() }));
vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: () => ({
      clearInputDenial: vi.fn(),
      resumeContext: vi.fn().mockResolvedValue(undefined),
      setInputDevice,
    }),
  },
}));

import { useUIStore } from '../stores/uiStore';
import { requestMicPermission } from './voice';
import i18n, { initI18n, setLanguage } from '../i18n';

function failWith(name: string): void {
  const err = new Error(name);
  err.name = name;
  setInputDevice.mockRejectedValueOnce(err);
}

describe('the "Allow microphone" retry', () => {
  beforeEach(async () => {
    await initI18n();
    await setLanguage('de');
    useUIStore.setState({ toasts: [] });
  });
  afterEach(async () => { await setLanguage('en'); });

  it.each([
    ['NotAllowedError', 'voice:micRetry.stillDenied'],
    ['NotFoundError', 'voice:micRetry.notFound'],
    ['AbortError', 'voice:micRetry.failed'],
  ])('says why it failed (%s) in the selected language', async (name, key) => {
    failWith(name);

    await expect(requestMicPermission()).resolves.toBe(false);

    const messages = useUIStore.getState().toasts.map((t) => t.message);
    expect(messages).toEqual([i18n.t(key)]);
    expect(messages[0]).not.toBe(i18n.t(key, { lng: 'en' }));
  });
});
