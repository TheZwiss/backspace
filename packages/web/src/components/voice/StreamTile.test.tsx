import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { StreamTile as StreamTileType } from '../../hooks/useLiveKit';
import { StreamTile } from './StreamTile';

const mocks = vi.hoisted(() => ({
  voiceState: {
    watchingStreams: new Set(['alice']),
    voiceConnectionStatus: 'connected',
    connectionQuality: 'good',
    connectionQualities: new Map(),
    streamVolumes: new Map(),
    streamAttenuationEnabled: false,
    streamAttenuationStrength: 50,
  },
  drawImage: vi.fn(),
}));

vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: Object.assign((selector: (state: typeof mocks.voiceState) => unknown) => selector(mocks.voiceState), {
    getState: () => mocks.voiceState,
  }),
}));
vi.mock('../../utils/streamPreviews', () => ({ useStreamPreviews: (selector: (state: unknown) => unknown) => selector({ images: {} }) }));
vi.mock('../../hooks/useVoiceParticipantMeta', () => ({ useVoiceParticipantMeta: () => ({ displayName: 'Alice', avatar: null, user: null }) }));
vi.mock('../../i18n/formatters', () => ({ useFormatters: () => ({ formatPercent: (value: number) => `${value}%` }) }));
vi.mock('../../hooks/useLiveKit', () => ({ getActiveRoom: () => null, setStreamSubscription: vi.fn() }));
vi.mock('../../utils/screenShare', () => ({ stopScreenShare: vi.fn(), changeScreenShare: vi.fn(), effectiveScreenShareConfig: () => ({ height: 720, fps: 30 }) }));
vi.mock('../../utils/streamHostLimits', () => ({ useStreamHostLimits: () => ({ limits: null }) }));
vi.mock('../../stores/contextMenuStore', () => ({ useContextMenuStore: (selector: (state: { open: () => void }) => unknown) => selector({ open: vi.fn() }) }));
vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({ playSound: vi.fn() }) } }));
vi.mock('../../utils/sfx', () => ({ getSfxVolume: () => 1 }));
vi.mock('./StreamLiveBadge', () => ({ StreamLiveBadge: () => null }));
vi.mock('../ui/Avatar', () => ({ Avatar: () => null }));
vi.mock('./ScreenShareSettingsPopover', () => ({ ScreenShareSettingsPopover: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function makeTrack() {
  return {
    attach: vi.fn(),
    detach: vi.fn(() => undefined),
  };
}

function makeMediaTrack(): MediaStreamTrack {
  return {
    readyState: 'live',
    getSettings: () => ({ height: 720, frameRate: 30 }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
}

function makeTile(screenTrack: MediaStreamTrack | null, lkScreenTrack: ReturnType<typeof makeTrack> | null, isRepublishing = false, revision = isRepublishing ? 1 : 0): StreamTileType {
  return {
    kind: 'stream',
    key: 'alice:stream',
    participant: {
      identity: 'alice:identity', userId: 'alice', username: 'alice', displayName: 'Alice', avatar: null,
      homeUserId: null, isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: true,
      isLocal: false, audioTrack: null, videoTrack: null, screenTrack, screenAudioTrack: null,
      isScreenShareRepublishing: isRepublishing,
      isScreenShareRepublishRevision: revision,
      lkVideoTrack: null, lkScreenTrack, cachedUser: null,
    },
    screenTrack,
    screenAudioTrack: null,
    lkScreenTrack: lkScreenTrack as never,
  };
}

beforeEach(() => {
  mocks.voiceState.watchingStreams = new Set(['alice']);
  mocks.drawImage.mockClear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: mocks.drawImage } as unknown as CanvasRenderingContext2D);
});

describe('StreamTile codec republish continuity', () => {
  it('keeps the video node and captures its last frame before detaching through the null-track bridge', () => {
    const oldTrack = makeTrack();
    const mediaTrack = makeMediaTrack();
    const { rerender } = render(<StreamTile tile={makeTile(mediaTrack, oldTrack)} stats={null} />);
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1280 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 720 });

    rerender(<StreamTile tile={makeTile(null, null)} stats={null} />);

    expect(document.querySelector('video')).toBe(video);
    expect(mocks.drawImage).toHaveBeenCalledWith(video, 0, 0, 1280, 720);
    expect(oldTrack.detach).toHaveBeenCalledWith(video);
    expect(mocks.drawImage.mock.invocationCallOrder[0]).toBeLessThan(oldTrack.detach.mock.invocationCallOrder[0]);
    expect(screen.getByTestId('stream-tile-frozen-frame')).toBeInTheDocument();
  });

  it('snapshots once at republish announcement, keeps it through the bridge, and clears on the replacement frame', () => {
    const sdkTrack = makeTrack();
    const mediaTrack = makeMediaTrack();
    const { rerender } = render(<StreamTile tile={makeTile(mediaTrack, sdkTrack)} stats={null} />);
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1280 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 720 });
    fireEvent.loadedData(video);

    rerender(<StreamTile tile={makeTile(mediaTrack, sdkTrack, true, 1)} stats={null} />);
    expect(screen.getByTestId('stream-tile-frozen-frame')).toBeInTheDocument();
    expect(mocks.drawImage).toHaveBeenCalledWith(video, 0, 0, 1280, 720);
    expect(mocks.drawImage.mock.calls.filter(([source]) => source === video)).toHaveLength(1);
    expect(sdkTrack.detach).not.toHaveBeenCalled();
    fireEvent.loadedData(video);
    expect(screen.getByTestId('stream-tile-frozen-frame')).toBeInTheDocument();

    rerender(<StreamTile tile={makeTile(null, null, true, 1)} stats={null} />);
    expect(sdkTrack.detach).toHaveBeenCalledWith(video);
    expect(screen.getByTestId('stream-tile-frozen-frame')).toBeInTheDocument();
    expect(mocks.drawImage.mock.calls.filter(([source]) => source === video)).toHaveLength(1);

    const replacementSdkTrack = makeTrack();
    rerender(<StreamTile tile={makeTile(makeMediaTrack(), replacementSdkTrack, false, 1)} stats={null} />);
    expect(screen.getByTestId('stream-tile-frozen-frame')).toBeInTheDocument();
    fireEvent.loadedData(video);
    expect(screen.queryByTestId('stream-tile-frozen-frame')).toBeNull();
  });

  it('clears an announcement snapshot if republish ends without a track gap', () => {
    const sdkTrack = makeTrack();
    const tile = makeTile(makeMediaTrack(), sdkTrack);
    const { rerender } = render(<StreamTile tile={tile} stats={null} />);
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1280 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 720 });
    fireEvent.loadedData(video);

    rerender(<StreamTile tile={makeTile(tile.screenTrack, sdkTrack, true, 1)} stats={null} />);
    expect(screen.getByTestId('stream-tile-frozen-frame')).toBeInTheDocument();
    rerender(<StreamTile tile={tile} stats={null} />);
    expect(screen.queryByTestId('stream-tile-frozen-frame')).toBeNull();
  });

  it('captures the first frame after a second announcement made during the track gap', () => {
    const firstSdkTrack = makeTrack();
    const firstTile = makeTile(makeMediaTrack(), firstSdkTrack);
    const { rerender } = render(<StreamTile tile={firstTile} stats={null} />);
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1280 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 720 });
    fireEvent.loadedData(video);

    rerender(<StreamTile tile={makeTile(firstTile.screenTrack, firstSdkTrack, true, 1)} stats={null} />);
    rerender(<StreamTile tile={makeTile(null, null, true, 1)} stats={null} />);
    expect(screen.getByTestId('stream-tile-frozen-frame')).toBeInTheDocument();
    const firstSnapshotCount = mocks.drawImage.mock.calls.filter(([source]) => source === video).length;

    rerender(<StreamTile tile={makeTile(null, null, true, 2)} stats={null} />);
    const secondSdkTrack = makeTrack();
    rerender(<StreamTile tile={makeTile(makeMediaTrack(), secondSdkTrack, true, 2)} stats={null} />);
    fireEvent.loadedData(video);
    expect(screen.getByTestId('stream-tile-frozen-frame')).toBeInTheDocument();
    expect(mocks.drawImage.mock.calls.filter(([source]) => source === video)).toHaveLength(firstSnapshotCount + 1);

    rerender(<StreamTile tile={makeTile(null, null, true, 2)} stats={null} />);
    expect(screen.getByTestId('stream-tile-frozen-frame')).toBeInTheDocument();
    const thirdSdkTrack = makeTrack();
    rerender(<StreamTile tile={makeTile(makeMediaTrack(), thirdSdkTrack, true, 2)} stats={null} />);
    fireEvent.loadedData(video);
    expect(screen.queryByTestId('stream-tile-frozen-frame')).toBeNull();
  });

  it('clears a second-revision snapshot if that announcement expires without another gap', () => {
    const firstSdkTrack = makeTrack();
    const firstTile = makeTile(makeMediaTrack(), firstSdkTrack);
    const { rerender } = render(<StreamTile tile={firstTile} stats={null} />);
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1280 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 720 });
    fireEvent.loadedData(video);

    rerender(<StreamTile tile={makeTile(firstTile.screenTrack, firstSdkTrack, true, 1)} stats={null} />);
    rerender(<StreamTile tile={makeTile(null, null, true, 1)} stats={null} />);
    rerender(<StreamTile tile={makeTile(null, null, true, 2)} stats={null} />);
    const secondSdkTrack = makeTrack();
    const secondMediaTrack = makeMediaTrack();
    rerender(<StreamTile tile={makeTile(secondMediaTrack, secondSdkTrack, true, 2)} stats={null} />);
    fireEvent.loadedData(video);
    expect(screen.getByTestId('stream-tile-frozen-frame')).toBeInTheDocument();

    // The second announcement expired, but the second publication never left.
    rerender(<StreamTile tile={makeTile(secondMediaTrack, secondSdkTrack, false, 0)} stats={null} />);
    expect(screen.queryByTestId('stream-tile-frozen-frame')).toBeNull();
  });

  it('releases the frozen canvas on a replacement track frame and clears it when unwatched', () => {
    const oldTrack = makeTrack();
    const mediaTrack = makeMediaTrack();
    const { rerender } = render(<StreamTile tile={makeTile(mediaTrack, oldTrack)} stats={null} />);
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1280 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 720 });
    rerender(<StreamTile tile={makeTile(null, null)} stats={null} />);
    expect(screen.getByTestId('stream-tile-frozen-frame')).toBeInTheDocument();

    const replacementTrack = makeTrack();
    const replacementMedia = makeMediaTrack();
    rerender(<StreamTile tile={makeTile(replacementMedia, replacementTrack)} stats={null} />);
    expect(document.querySelector('video')).toBe(video);
    fireEvent.loadedData(video);
    expect(screen.queryByTestId('stream-tile-frozen-frame')).toBeNull();

    rerender(<StreamTile tile={makeTile(null, null)} stats={null} />);
    expect(screen.getByTestId('stream-tile-frozen-frame')).toBeInTheDocument();
    mocks.voiceState.watchingStreams = new Set();
    rerender(<StreamTile tile={makeTile(null, null)} stats={null} />);
    expect(screen.queryByTestId('stream-tile-frozen-frame')).toBeNull();
    expect(document.querySelector('video')).toBeNull();
  });

  it('reattaches the same SDK track to a new video element after unwatch and clears frozen state', () => {
    const sdkTrack = makeTrack();
    const mediaTrack = makeMediaTrack();
    const tile = makeTile(mediaTrack, sdkTrack);
    const { rerender } = render(<StreamTile tile={tile} stats={null} />);
    const firstVideo = document.querySelector('video')!;
    Object.defineProperty(firstVideo, 'videoWidth', { configurable: true, value: 1280 });
    Object.defineProperty(firstVideo, 'videoHeight', { configurable: true, value: 720 });

    rerender(<StreamTile tile={makeTile(null, null)} stats={null} />);
    expect(screen.getByTestId('stream-tile-frozen-frame')).toBeInTheDocument();
    rerender(<StreamTile tile={tile} stats={null} />);
    fireEvent.loadedData(firstVideo);
    expect(screen.queryByTestId('stream-tile-frozen-frame')).toBeNull();

    mocks.voiceState.watchingStreams = new Set();
    rerender(<StreamTile tile={tile} stats={null} />);
    expect(screen.queryByTestId('stream-tile-frozen-frame')).toBeNull();
    expect(document.querySelector('video')).toBeNull();

    mocks.voiceState.watchingStreams = new Set(['alice']);
    rerender(<StreamTile tile={tile} stats={null} />);
    const secondVideo = document.querySelector('video')!;
    expect(secondVideo).not.toBe(firstVideo);
    expect(sdkTrack.attach).toHaveBeenNthCalledWith(2, secondVideo);
    expect(screen.queryByTestId('stream-tile-frozen-frame')).toBeNull();
  });
});
