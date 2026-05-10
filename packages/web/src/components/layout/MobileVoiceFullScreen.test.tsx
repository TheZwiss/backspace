/**
 * Verifies the mobile voice fullscreen renders the same VoiceGrid pipeline
 * as desktop, so cameras (local + remote) and screen-share tiles appear in
 * the participant grid.
 *
 * jsdom can't host a real LiveKit Room, so we test at the rendering layer:
 * - Seed `voiceStore.participants` with synthetic ParticipantInfo entries.
 * - Mount MobileVoiceFullScreen.
 * - Assert the DOM contains the right number of <video> elements (one per
 *   user-tile-with-camera + one per stream-tile).
 *
 * If anyone re-introduces the avatar-only mobile grid, this test fails.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// jsdom doesn't ship ResizeObserver; useGridLayout needs it.
if (typeof globalThis.ResizeObserver === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
import { MobileVoiceFullScreen } from './MobileVoiceFullScreen';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';

// LiveKit client imports drag in heavy stuff; track.attach on a dead track
// throws in jsdom, so stub the parts that touch DOM.
vi.mock('../../hooks/useWebSocket', () => ({
  wsSend: vi.fn(),
  useWebSocket: vi.fn(),
}));

vi.mock('../../hooks/useLiveKit', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    getActiveRoom: () => null,
    setStreamSubscription: vi.fn(),
    setCameraSubscription: vi.fn(),
  };
});

// AudioManager is a singleton with browser-only deps.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({ resumeContext: vi.fn() }) },
}));

vi.mock('../../utils/voiceActions', async () => ({
  handleCameraAction: vi.fn(),
  handleScreenShareAction: vi.fn(),
}));

function makeFakeMediaStreamTrack(kind: 'video' | 'audio'): MediaStreamTrack {
  // Minimal stand-in. VoiceGrid's deriveGridTiles only inspects
  // p.videoTrack?.readyState; VoiceUser/StreamTile attach via
  // lkVideoTrack/lkScreenTrack which we mock as null below.
  const t = {
    kind,
    readyState: 'live',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getSettings: () => ({ height: 720, frameRate: 30 }),
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
  return t;
}

function makeParticipant(overrides: Partial<any>): any {
  return {
    identity: '1:alice',
    userId: '1',
    username: 'alice',
    homeUserId: null,
    isMuted: false,
    isDeafened: false,
    isCameraOn: false,
    isScreenSharing: false,
    isLocal: false,
    audioTrack: null,
    videoTrack: null,
    screenTrack: null,
    screenAudioTrack: null,
    lkVideoTrack: null,
    lkScreenTrack: null,
    cachedUser: null,
    ...overrides,
  };
}

beforeEach(() => {
  // Reset relevant store slices.
  useVoiceStore.setState({
    currentVoiceChannelId: 'channel-A',
    isMuted: false,
    isDeafened: false,
    isCameraOn: false,
    isScreenSharing: false,
    participants: [],
    voiceUsers: new Map(),
    voiceUserStates: new Map(),
    spaceMutedUserIds: new Set(),
    spaceDeafenedUserIds: new Set(),
    permissionMutedUserIds: new Set(),
    speakingParticipantIds: new Set(),
    focusedParticipantId: null,
    activeDmCall: null,
    participantMutes: new Map(),
    streamMutes: new Map(),
    watchingStreams: new Set(),
    unwatchedCameras: new Set(),
  });
  useSpaceStore.setState({
    channels: [{ id: 'channel-A', name: 'general', type: 'voice' } as any],
    dmChannels: [],
    spaces: [],
    channelToSpaceMap: new Map([['channel-A', 'space-A']]),
    members: [],
  } as any);
  useAuthStore.setState({
    user: { id: '1', username: 'alice', displayName: 'Alice' },
  } as any);
});

function renderScreen() {
  return render(
    <MemoryRouter>
      <MobileVoiceFullScreen />
    </MemoryRouter>,
  );
}

describe('MobileVoiceFullScreen', () => {
  it('renders the VoiceGrid waiting state when no participants', () => {
    const { container } = renderScreen();
    // No <video> until participants exist.
    expect(container.querySelectorAll('video').length).toBe(0);
    // Waiting copy or "0 connected".
    expect(container.textContent).toMatch(/0 connected/);
  });

  it('renders a video element for the local user when their camera is on', () => {
    useVoiceStore.setState({
      participants: [
        makeParticipant({
          identity: '1:alice',
          userId: '1',
          username: 'alice',
          isLocal: true,
          isCameraOn: true,
          videoTrack: makeFakeMediaStreamTrack('video'),
        }),
      ],
    });

    const { container } = renderScreen();
    // One user-tile, one <video> for the local camera.
    const videos = container.querySelectorAll('video');
    expect(videos.length).toBe(1);
    // Local video must be muted to prevent echo.
    expect(videos[0]).toHaveAttribute('autoplay');
    expect((videos[0] as HTMLVideoElement).muted).toBe(true);
  });

  it('renders a video element for a remote user with camera on', () => {
    useVoiceStore.setState({
      participants: [
        makeParticipant({
          identity: '1:alice',
          userId: '1',
          username: 'alice',
          isLocal: true,
        }),
        makeParticipant({
          identity: '2:bob',
          userId: '2',
          username: 'bob',
          isLocal: false,
          isCameraOn: true,
          videoTrack: makeFakeMediaStreamTrack('video'),
        }),
      ],
    });

    const { container } = renderScreen();
    // Alice (no camera) → avatar tile with no <video>.
    // Bob (camera on) → <video> tile.
    expect(container.querySelectorAll('video').length).toBe(1);
    expect(container.textContent).toMatch(/2 connected/);
  });

  it('renders an extra StreamTile when a participant publishes screen-share', () => {
    useVoiceStore.setState({
      participants: [
        makeParticipant({
          identity: '1:alice',
          userId: '1',
          username: 'alice',
          isLocal: true,
        }),
        makeParticipant({
          identity: '2:bob',
          userId: '2',
          username: 'bob',
          isLocal: false,
          isScreenSharing: true,
          screenTrack: makeFakeMediaStreamTrack('video'),
        }),
      ],
    });

    const { container } = renderScreen();
    // The grid should now contain Bob's user tile + a separate StreamTile
    // (avatar placeholder until Watch Stream is tapped). Look for the LIVE
    // badge in the StreamTile.
    expect(container.textContent).toMatch(/LIVE/);
    expect(container.textContent).toMatch(/is streaming/i);
  });

  it('auto-focuses the first live screen-share publication on mount', async () => {
    useVoiceStore.setState({
      participants: [
        makeParticipant({
          identity: '1:alice',
          userId: '1',
          username: 'alice',
          isLocal: true,
        }),
        makeParticipant({
          identity: '2:bob',
          userId: '2',
          username: 'bob',
          isLocal: false,
          isScreenSharing: true,
          screenTrack: makeFakeMediaStreamTrack('video'),
        }),
      ],
    });

    renderScreen();

    // Auto-focus runs in a useEffect. Flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(useVoiceStore.getState().focusedParticipantId).toBe('2:bob:stream');
  });

  it('clears focus on unmount so re-entering the screen is a clean slate', async () => {
    useVoiceStore.setState({
      participants: [
        makeParticipant({
          identity: '2:bob',
          userId: '2',
          username: 'bob',
          isLocal: false,
          isScreenSharing: true,
          screenTrack: makeFakeMediaStreamTrack('video'),
        }),
      ],
    });

    const { unmount } = renderScreen();
    await new Promise((r) => setTimeout(r, 0));
    expect(useVoiceStore.getState().focusedParticipantId).toBe('2:bob:stream');

    unmount();
    expect(useVoiceStore.getState().focusedParticipantId).toBeNull();
  });

  it('renders a screen-share button that calls the canonical handler', async () => {
    const { handleScreenShareAction } = await import('../../utils/voiceActions');
    useVoiceStore.setState({
      participants: [
        makeParticipant({
          identity: '1:alice',
          userId: '1',
          username: 'alice',
          isLocal: true,
        }),
      ],
    });

    const { container } = renderScreen();
    const btn = container.querySelector(
      'button[aria-label="Share screen"], button[aria-label="Stop sharing screen"]',
    ) as HTMLButtonElement | null;
    expect(btn).toBeTruthy();
    btn?.click();
    expect(handleScreenShareAction).toHaveBeenCalled();
  });
});
