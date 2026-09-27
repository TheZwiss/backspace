import { act, cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceStore } from '../../stores/voiceStore';
import { SwAutoUpdate } from './SwUpdatePrompt';

// voiceStore imports AudioManager, and jsdom has no AudioWorkletNode.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setInputVolume: vi.fn(),
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

// ── virtual:pwa-register/react ─────────────────────────────────────────────
// The real hook drives workbox-window. The fake exposes the two things the
// component reads (the needRefresh flag and updateServiceWorker) and lets the
// test raise needRefresh the way a waiting worker would.

interface RegisterOptions {
  onNeedReload?: () => void;
  onRegisteredSW?: (swUrl: string, registration: ServiceWorkerRegistration | undefined) => void;
}

const pwa = vi.hoisted(() => ({
  updateServiceWorker: vi.fn<(reloadPage?: boolean) => Promise<void>>(),
  setNeedRefresh: null as ((value: boolean) => void) | null,
}));

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: (options: RegisterOptions = {}) => {
    const [needRefresh, setNeedRefresh] = useState(false);
    const [offlineReady, setOfflineReady] = useState(false);
    pwa.setNeedRefresh = setNeedRefresh;
    void options;
    return {
      needRefresh: [needRefresh, setNeedRefresh],
      offlineReady: [offlineReady, setOfflineReady],
      updateServiceWorker: pwa.updateServiceWorker,
    };
  },
}));

// ── navigator.serviceWorker ────────────────────────────────────────────────

class FakeServiceWorkerContainer extends EventTarget {
  controller: ServiceWorker | null = null;
}

function fakeWorker(name: string): ServiceWorker {
  return { scriptURL: `/sw.js#${name}` } as unknown as ServiceWorker;
}

// ── navigator.locks ────────────────────────────────────────────────────────
// A LockManager following the Web Locks queueing rules: requests for one name
// are granted strictly in order, shared requests share with shared holders,
// and a request aborted while queued rejects with AbortError. Other tabs are
// simulated by calling request() on the same instance from the test.

type LockMode = 'shared' | 'exclusive';

interface QueuedRequest {
  name: string;
  mode: LockMode;
  callback: (lock: Lock | null) => unknown;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
}

interface HeldLock {
  name: string;
  mode: LockMode;
}

class FakeLockManager {
  held: HeldLock[] = [];
  queue: QueuedRequest[] = [];
  /** Every request, with the locks that were held at the moment it was made. */
  log: { mode: LockMode; heldAtRequest: HeldLock[] }[] = [];

  request(
    name: string,
    optionsOrCallback: LockOptions | ((lock: Lock | null) => unknown),
    maybeCallback?: (lock: Lock | null) => unknown,
  ): Promise<unknown> {
    const options: LockOptions = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    if (!callback) throw new TypeError('callback required');
    const signal = options.signal ?? undefined;
    if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
    this.log.push({ mode: options.mode ?? 'exclusive', heldAtRequest: [...this.held] });
    return new Promise((resolve, reject) => {
      const entry: QueuedRequest = {
        name,
        mode: options.mode ?? 'exclusive',
        callback,
        resolve,
        reject,
        signal,
      };
      signal?.addEventListener('abort', () => {
        const index = this.queue.indexOf(entry);
        if (index === -1) return;
        this.queue.splice(index, 1);
        reject(new DOMException('aborted', 'AbortError'));
        this.process();
      });
      this.queue.push(entry);
      this.process();
    });
  }

  query(): Promise<LockManagerSnapshot> {
    return Promise.resolve({
      held: this.held.map((l) => ({ name: l.name, mode: l.mode, clientId: 'fake' })),
      pending: this.queue.map((r) => ({ name: r.name, mode: r.mode, clientId: 'fake' })),
    });
  }

  private process(): void {
    for (let i = 0; i < this.queue.length; i++) {
      const entry = this.queue[i];
      const earlierForName = this.queue.slice(0, i).some((r) => r.name === entry.name);
      if (earlierForName) continue;
      const heldForName = this.held.filter((l) => l.name === entry.name);
      const grantable = entry.mode === 'exclusive'
        ? heldForName.length === 0
        : heldForName.every((l) => l.mode === 'shared');
      if (!grantable) continue;
      this.queue.splice(i, 1);
      i--;
      const heldLock: HeldLock = { name: entry.name, mode: entry.mode };
      this.held.push(heldLock);
      const release = () => {
        this.held.splice(this.held.indexOf(heldLock), 1);
        this.process();
      };
      Promise.resolve()
        .then(() => entry.callback({ name: entry.name, mode: entry.mode } as Lock))
        .then(
          (value) => { release(); entry.resolve(value); },
          (error: unknown) => { release(); entry.reject(error); },
        );
    }
  }

  count(name: string, mode: LockMode): { held: number; pending: number } {
    return {
      held: this.held.filter((l) => l.name === name && l.mode === mode).length,
      pending: this.queue.filter((r) => r.name === name && r.mode === mode).length,
    };
  }
}

const LOCK_NAME = 'backspace-voice-session';

/** Holds the shared voice-session lock the way another tab in a call would. */
function otherTabJoinsCall(locks: FakeLockManager): { leave: () => void } {
  let leave: () => void = () => {};
  const held = new Promise<void>((resolve) => { leave = resolve; });
  void locks.request(LOCK_NAME, { mode: 'shared' }, () => held);
  return { leave: () => leave() };
}

// ── harness ────────────────────────────────────────────────────────────────

let container: FakeServiceWorkerContainer;
let locks: FakeLockManager;
let reload: ReturnType<typeof vi.fn<() => void>>;
const originalLocation = window.location;

function installLocks(value: FakeLockManager | undefined): void {
  Object.defineProperty(navigator, 'locks', { value, configurable: true, writable: true });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function setVoice(state: Partial<ReturnType<typeof useVoiceStore.getState>>): Promise<void> {
  await act(async () => {
    useVoiceStore.setState(state);
  });
  await flush();
}

async function endSession(): Promise<void> {
  await act(async () => {
    useVoiceStore.getState().resetSession();
  });
  await flush();
}

async function raiseNeedRefresh(): Promise<void> {
  await act(async () => {
    pwa.setNeedRefresh?.(true);
  });
  await flush();
}

async function changeController(next: ServiceWorker): Promise<void> {
  await act(async () => {
    container.controller = next;
    container.dispatchEvent(new Event('controllerchange'));
  });
  await flush();
}

beforeEach(() => {
  useVoiceStore.getState().resetSession();
  pwa.updateServiceWorker.mockReset();
  pwa.updateServiceWorker.mockResolvedValue(undefined);
  pwa.setNeedRefresh = null;

  container = new FakeServiceWorkerContainer();
  Object.defineProperty(navigator, 'serviceWorker', { value: container, configurable: true, writable: true });

  locks = new FakeLockManager();
  installLocks(locks);

  reload = vi.fn<() => void>();
  Object.defineProperty(window, 'location', {
    value: { ...originalLocation, reload },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  // Unmount while the fakes are still installed, so effect cleanups run
  // against the same navigator objects they subscribed to.
  cleanup();
  Object.defineProperty(window, 'location', { value: originalLocation, configurable: true, writable: true });
  Reflect.deleteProperty(navigator, 'serviceWorker');
  Reflect.deleteProperty(navigator, 'locks');
  useVoiceStore.getState().resetSession();
});

describe('SwAutoUpdate: applying a waiting build', () => {
  it('holds the update while in a voice channel and applies it once the call ends', async () => {
    container.controller = fakeWorker('old');
    render(<SwAutoUpdate />);
    await setVoice({ voiceConnectionStatus: 'connected', currentVoiceChannelId: 'voice-1' });

    await raiseNeedRefresh();
    expect(pwa.updateServiceWorker).not.toHaveBeenCalled();

    await endSession();
    expect(pwa.updateServiceWorker).toHaveBeenCalledTimes(1);
  });

  it('holds the update while an outgoing DM call is ringing', async () => {
    render(<SwAutoUpdate />);
    // The caller is not in LiveKit until dm_call_accepted.
    await setVoice({ outgoingCall: { dmChannelId: 'dm-1' } });

    await raiseNeedRefresh();
    expect(pwa.updateServiceWorker).not.toHaveBeenCalled();

    await endSession();
    expect(pwa.updateServiceWorker).toHaveBeenCalledTimes(1);
  });

  it('holds the update while an incoming DM call is ringing', async () => {
    render(<SwAutoUpdate />);
    await setVoice({ incomingCall: { dmChannelId: 'dm-1', callerId: 'u-2', callerName: 'Mira' } });

    await raiseNeedRefresh();
    expect(pwa.updateServiceWorker).not.toHaveBeenCalled();

    await endSession();
    expect(pwa.updateServiceWorker).toHaveBeenCalledTimes(1);
  });

  it('holds the update after an exhausted reconnect that kept the channel', async () => {
    render(<SwAutoUpdate />);
    // LiveKit gave up: the status is back to disconnected, but the channel
    // stays so VoiceControls can offer a retry.
    await setVoice({ voiceConnectionStatus: 'disconnected', currentVoiceChannelId: 'voice-1' });

    await raiseNeedRefresh();
    expect(pwa.updateServiceWorker).not.toHaveBeenCalled();

    await endSession();
    expect(pwa.updateServiceWorker).toHaveBeenCalledTimes(1);
  });

  it('applies the update at once when no tab is in a call', async () => {
    render(<SwAutoUpdate />);
    await raiseNeedRefresh();
    expect(pwa.updateServiceWorker).toHaveBeenCalledTimes(1);
  });

  it('falls back to the per-tab rule when the Web Locks API is missing', async () => {
    installLocks(undefined);
    render(<SwAutoUpdate />);
    await setVoice({ voiceConnectionStatus: 'connected', currentVoiceChannelId: 'voice-1' });

    await raiseNeedRefresh();
    expect(pwa.updateServiceWorker).not.toHaveBeenCalled();

    await endSession();
    expect(pwa.updateServiceWorker).toHaveBeenCalledTimes(1);
  });
});

describe('SwAutoUpdate: reloading onto the new build', () => {
  it('holds the reload while in a call and reloads after it', async () => {
    container.controller = fakeWorker('old');
    render(<SwAutoUpdate />);
    await setVoice({ voiceConnectionStatus: 'connected', currentVoiceChannelId: 'voice-1' });

    await changeController(fakeWorker('new'));
    expect(reload).not.toHaveBeenCalled();

    await endSession();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload when the first worker takes control of an uncontrolled page', async () => {
    render(<SwAutoUpdate />);
    await changeController(fakeWorker('first'));
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads when a worker replaces the one that controlled the page at load', async () => {
    container.controller = fakeWorker('old');
    render(<SwAutoUpdate />);
    await changeController(fakeWorker('new'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads when a worker replaces one that was first installed during this session', async () => {
    // The desktop app clears service workers on launch, so every session
    // starts uncontrolled and the first deploy is worker to worker.
    render(<SwAutoUpdate />);
    await changeController(fakeWorker('first'));
    expect(reload).not.toHaveBeenCalled();

    await changeController(fakeWorker('second'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not send SKIP_WAITING while a reload is pending', async () => {
    container.controller = fakeWorker('old');
    render(<SwAutoUpdate />);
    await setVoice({ voiceConnectionStatus: 'connected', currentVoiceChannelId: 'voice-1' });
    await changeController(fakeWorker('new'));
    await raiseNeedRefresh();

    await endSession();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(pwa.updateServiceWorker).not.toHaveBeenCalled();
  });
});

describe('SwAutoUpdate: cross-tab voice-session lock', () => {
  it('holds a shared lock for exactly as long as this tab has a voice session', async () => {
    render(<SwAutoUpdate />);
    expect(locks.count(LOCK_NAME, 'shared').held).toBe(0);

    await setVoice({ outgoingCall: { dmChannelId: 'dm-1' } });
    expect(locks.count(LOCK_NAME, 'shared').held).toBe(1);

    await setVoice({ outgoingCall: null, activeDmCall: { dmChannelId: 'dm-1' }, voiceConnectionStatus: 'connecting' });
    expect(locks.count(LOCK_NAME, 'shared').held).toBe(1);

    await endSession();
    expect(locks.count(LOCK_NAME, 'shared').held).toBe(0);
  });

  it('releases the shared lock on unmount', async () => {
    const view = render(<SwAutoUpdate />);
    await setVoice({ voiceConnectionStatus: 'connected', currentVoiceChannelId: 'voice-1' });
    expect(locks.count(LOCK_NAME, 'shared').held).toBe(1);

    view.unmount();
    await flush();
    expect(locks.count(LOCK_NAME, 'shared').held).toBe(0);
  });

  it('holds the update while another tab is in a call', async () => {
    const otherTab = otherTabJoinsCall(locks);
    await flush();
    render(<SwAutoUpdate />);

    await raiseNeedRefresh();
    expect(pwa.updateServiceWorker).not.toHaveBeenCalled();

    otherTab.leave();
    await flush();
    expect(pwa.updateServiceWorker).toHaveBeenCalledTimes(1);
  });

  it('keeps holding when another tab joins a call while the update waits', async () => {
    const firstTab = otherTabJoinsCall(locks);
    await flush();
    render(<SwAutoUpdate />);
    await raiseNeedRefresh();
    expect(locks.count(LOCK_NAME, 'exclusive').pending).toBe(1);

    // This tab's exclusive request is queued, so the new caller's shared
    // request queues behind it rather than being granted.
    const secondTab = otherTabJoinsCall(locks);
    await flush();

    firstTab.leave();
    await flush();
    expect(pwa.updateServiceWorker).not.toHaveBeenCalled();
    expect(locks.count(LOCK_NAME, 'shared').held).toBe(1);

    secondTab.leave();
    await flush();
    expect(pwa.updateServiceWorker).toHaveBeenCalledTimes(1);
  });

  it('withdraws its waiting update when this tab joins a call', async () => {
    const otherTab = otherTabJoinsCall(locks);
    await flush();
    render(<SwAutoUpdate />);
    await raiseNeedRefresh();
    expect(locks.count(LOCK_NAME, 'exclusive').pending).toBe(1);

    await setVoice({ voiceConnectionStatus: 'connected', currentVoiceChannelId: 'voice-1' });
    // The queued request is withdrawn, not left to be granted later.
    expect(locks.count(LOCK_NAME, 'exclusive').pending).toBe(0);

    otherTab.leave();
    await flush();
    expect(pwa.updateServiceWorker).not.toHaveBeenCalled();
    expect(locks.count(LOCK_NAME, 'exclusive').pending).toBe(0);
    expect(locks.count(LOCK_NAME, 'shared').held).toBe(1);

    await endSession();
    expect(pwa.updateServiceWorker).toHaveBeenCalledTimes(1);
  });

  it('never queues its update behind its own shared lock', async () => {
    render(<SwAutoUpdate />);
    await setVoice({ voiceConnectionStatus: 'connected', currentVoiceChannelId: 'voice-1' });
    await raiseNeedRefresh();
    expect(locks.count(LOCK_NAME, 'exclusive').pending).toBe(0);

    await endSession();
    expect(pwa.updateServiceWorker).toHaveBeenCalledTimes(1);
    const exclusiveRequests = locks.log.filter((entry) => entry.mode === 'exclusive');
    expect(exclusiveRequests).toHaveLength(1);
    expect(exclusiveRequests[0].heldAtRequest).toEqual([]);
    expect(locks.held).toHaveLength(0);
    expect(locks.queue).toHaveLength(0);
  });
});
