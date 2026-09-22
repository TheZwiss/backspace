import { describe, it, expect, beforeEach, vi } from 'vitest';

// The same shims as instanceStore.tokenResolver.test.ts, so importing the
// store does not pull in the real WS, audio or federation machinery.
vi.mock('../utils/dmOriginFailover', () => ({
  failoverDmOriginsFromDisconnected: vi.fn(),
}));
vi.mock('../hooks/useWebSocket', () => ({
  connectInstance: vi.fn(),
  disconnectInstance: vi.fn(),
  disconnectAllRemote: vi.fn(),
}));
vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));

import { useInstanceStore, waitForAutoConnect } from './instanceStore';

beforeEach(() => {
  useInstanceStore.setState({ instances: [], _autoConnectDone: false });
});

describe('waitForAutoConnect', () => {
  it('resolves at once when auto-connect has already finished', async () => {
    useInstanceStore.setState({ _autoConnectDone: true });
    let settled = false;
    const pending = waitForAutoConnect().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(true);
    await pending;
  });

  it('resolves when the flag flips, and only then', async () => {
    let settled = false;
    const pending = waitForAutoConnect().then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    useInstanceStore.setState({ instances: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    useInstanceStore.setState({ _autoConnectDone: true });
    await pending;
    expect(settled).toBe(true);
  });

  it('does not keep a subscription alive after resolving', async () => {
    const original = useInstanceStore.subscribe;
    const listeners: Array<ReturnType<typeof vi.fn>> = [];
    const subscribe = vi.spyOn(useInstanceStore, 'subscribe').mockImplementation((listener) => {
      const wrapped = vi.fn(listener);
      listeners.push(wrapped);
      return original(wrapped);
    });

    const pending = waitForAutoConnect();
    expect(listeners).toHaveLength(1);
    useInstanceStore.setState({ _autoConnectDone: true });
    await pending;
    const callsAtResolve = listeners[0]!.mock.calls.length;

    useInstanceStore.setState({ _autoConnectDone: false });
    useInstanceStore.setState({ _autoConnectDone: true });
    expect(listeners[0]!.mock.calls.length).toBe(callsAtResolve);
    subscribe.mockRestore();
  });
});
