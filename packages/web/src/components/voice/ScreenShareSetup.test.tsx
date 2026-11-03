import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Room } from 'livekit-client';
import { useVoiceStore } from '../../stores/voiceStore';
import { useScreenShareSetupStore } from '../../stores/screenShareSetupStore';

const mocks = vi.hoisted(() => ({
  api: null as BackspaceElectronAPI | null,
  room: null as Room | null,
  stream: null as MediaStream | null,
  capture: vi.fn(),
  stopStaged: vi.fn(),
  replace: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../platform/platform', () => ({
  getElectronAPI: () => mocks.api,
  isElectron: () => true,
  isElectronMac: () => false,
}));
vi.mock('../../hooks/useDialogLayer', () => ({ useDialogLayer: vi.fn() }));
vi.mock('../../hooks/usePortalContainer', () => ({ usePortalContainer: () => document.body }));
vi.mock('../../hooks/useLiveKit', () => ({ getActiveRoom: () => mocks.room }));
vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));
vi.mock('../../utils/voice', () => ({ broadcastVoiceStatus: vi.fn() }));
vi.mock('../../utils/screenShare', () => ({
  stageScreenCapture: (...args: unknown[]) => mocks.capture(...args),
  applyStagedCaptureConfig: vi.fn().mockResolvedValue(undefined),
  stopStagedCapture: (...args: unknown[]) => mocks.stopStaged(...args),
  publishScreenShare: (...args: unknown[]) => mocks.publish(...args),
  replaceScreenShare: (...args: unknown[]) => mocks.replace(...args),
  isScreenCaptureSupported: () => true,
  isCaptureCancellation: () => false,
  canAddScreenShareAudioLater: () => false,
}));
vi.mock('./StreamQualityControls', () => ({
  StreamQualityControls: ({ onChange }: { onChange?: (value: { fps: number }) => void }) => (
    <button onClick={() => onChange?.({ fps: 30 })}>Set draft FPS</button>
  ),
  StreamSummary: ({ config }: { config: { fps: number } }) => <span>FPS {config.fps}</span>,
  StreamHostSubtitle: () => null,
}));

import { ScreenShareSetup } from './ScreenShareSetup';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

function makeStream() {
  const listeners = new Map<string, Set<EventListener>>();
  const track = {
    kind: 'video',
    readyState: 'live',
    stop: vi.fn(),
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      const callbacks = listeners.get(type) ?? new Set<EventListener>();
      callbacks.add(listener);
      listeners.set(type, callbacks);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => listeners.get(type)?.delete(listener)),
    getSettings: () => ({ width: 1920, height: 1080 }),
    emitEnded: () => listeners.get('ended')?.forEach((listener) => listener(new Event('ended'))),
  };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
    getAudioTracks: () => [],
  };
  return { stream: stream as unknown as MediaStream, track };
}

const source = { id: 'screen:0:0', name: 'Display 1', thumbnailDataUrl: '', appIconDataUrl: null, isScreen: true };

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  mocks.stream = makeStream().stream;
  mocks.capture.mockResolvedValue(mocks.stream);
  mocks.stopStaged.mockReset().mockImplementation(() => undefined);
  mocks.replace.mockResolvedValue(true);
  mocks.publish.mockResolvedValue(true);
  mocks.api = {
    platform: 'win32',
    getScreenSharePickerMode: vi.fn().mockResolvedValue('app'),
    getScreenSources: vi.fn().mockResolvedValue([source]),
    preselectScreenSource: vi.fn().mockResolvedValue(undefined),
    getWindowCaptureTarget: vi.fn().mockResolvedValue(null),
    onScreenShareSources: vi.fn(),
  } as unknown as BackspaceElectronAPI;
  mocks.room = { state: 'connected' } as unknown as Room;
  useVoiceStore.setState({
    ...useVoiceStore.getInitialState(),
    isScreenSharing: true,
    screenShareConfig: {
      height: 1080,
      fps: 60,
      mode: 'gaming',
      customBitrateKbps: null,
      shareAudio: false,
      codec: 'vp9',
    },
  });
  useScreenShareSetupStore.getState().close();
});

afterEach(() => cleanup());

describe('ScreenShareSetup replacement flow', () => {
  it('keeps replacement quality as a draft and discards it on cancel', async () => {
    useScreenShareSetupStore.getState().open(undefined, 'replace');
    render(<ScreenShareSetup />);

    await screen.findAllByText('Display 1');
    await waitFor(() => expect(mocks.capture).toHaveBeenCalledOnce());
    const oldConfig = useVoiceStore.getState().screenShareConfig;
    fireEvent.click(screen.getByRole('button', { name: 'voice:streamSettings.title' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set draft FPS' }));

    expect(screen.getByText('FPS 30')).toBeInTheDocument();
    expect(useVoiceStore.getState().screenShareConfig).toEqual(oldConfig);

    fireEvent.click(screen.getByRole('button', { name: 'common:actions.cancel' }));

    expect(useScreenShareSetupStore.getState().isOpen).toBe(false);
    expect(useVoiceStore.getState().isScreenSharing).toBe(true);
    expect(useVoiceStore.getState().screenShareConfig).toEqual(oldConfig);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('keeps Start disabled while source enumeration is still loading', async () => {
    const sources = deferred<typeof source[]>();
    mocks.api.getScreenSources.mockReturnValue(sources.promise);
    useScreenShareSetupStore.getState().open(undefined, 'replace');
    render(<ScreenShareSetup />);

    const start = await screen.findByRole('button', { name: 'voice:screenPicker.start' });
    expect(start).toBeDisabled();
    expect(screen.getByText('voice:screenPicker.loadingSources')).toBeInTheDocument();
    fireEvent.click(start);
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();

    await act(async () => { sources.resolve([]); });
    expect(start).toBeDisabled();
    expect(useVoiceStore.getState().isScreenSharing).toBe(true);
  });

  it('does not let the previous capture ended event clear the newly staged source', async () => {
    const previous = makeStream();
    const next = makeStream();
    mocks.capture.mockReset().mockResolvedValueOnce(previous.stream).mockResolvedValueOnce(next.stream);
    mocks.stopStaged.mockImplementation((stream: MediaStream) => {
      if (!stream) return;
      (stream.getVideoTracks()[0] as MediaStreamTrack & { emitEnded?: () => void } | undefined)?.emitEnded?.();
    });
    useScreenShareSetupStore.getState().open(undefined, 'replace');
    render(<ScreenShareSetup />);

    await screen.findAllByText('Display 1');
    await waitFor(() => expect(mocks.capture).toHaveBeenCalledTimes(1));
    const sourceTile = screen.getByRole('button', { name: /Display 1/ });
    fireEvent.click(sourceTile);
    await waitFor(() => expect(mocks.capture).toHaveBeenCalledTimes(2));

    const start = screen.getByRole('button', { name: 'voice:screenPicker.start' });
    expect(start).toBeEnabled();
    fireEvent.click(start);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith(
      expect.anything(),
      next.stream,
      expect.objectContaining({ sourceId: source.id }),
    ));
  });
});


it('disconnects only the staged video player on blur and resumes it on focus', async () => {
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  try {
    useScreenShareSetupStore.getState().open(undefined, 'replace');
    render(<ScreenShareSetup />);
    await waitFor(() => expect(mocks.capture).toHaveBeenCalledOnce());
    await waitFor(() => expect(document.querySelector('video')?.srcObject).toBe(mocks.stream));
    const stoppedBefore = mocks.stopStaged.mock.calls.length;
    focus.mockReturnValue(false); fireEvent(window, new Event('blur'));
    expect(document.querySelector('video')?.srcObject).toBeNull();
    expect(mocks.stopStaged).toHaveBeenCalledTimes(stoppedBefore);
    focus.mockReturnValue(true); fireEvent(window, new Event('focus'));
    expect(document.querySelector('video')?.srcObject).toBe(mocks.stream);
  } finally { focus.mockRestore(); }
});
