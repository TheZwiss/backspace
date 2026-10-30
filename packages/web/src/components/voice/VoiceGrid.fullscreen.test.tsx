import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VoiceGrid } from './VoiceGrid';
import { useVoiceStore } from '../../stores/voiceStore';

vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));
vi.mock('../../hooks/useLiveKit', () => ({ deriveGridTiles: () => [
  { kind: 'stream', key: 'alice:stream', screenTrack: { readyState: 'live' }, participant: { userId: 'alice', isLocal: false } },
  { kind: 'user', key: 'bob', participant: { userId: 'bob' } },
] }));
vi.mock('../../hooks/useTrackStats', () => ({ useTrackStats: () => null }));
vi.mock('./VoiceUser', () => ({ VoiceUser: () => <div>Bob</div> }));
vi.mock('./StreamTile', () => ({ StreamTile: ({ borderless }: { borderless: boolean }) => <div data-testid="stream" data-borderless={String(!!borderless)}>Stream</div> }));

beforeEach(() => useVoiceStore.setState({ focusedParticipantId: 'alice:stream', watchingStreams: new Set() }));

describe('focused stream fullscreen', () => {
  it('uses a borderless tile and reveals the participant strip over the video', async () => {
    const { rerender } = render(<VoiceGrid participants={[]} fullscreen chromeRevealed={false} />);
    expect(screen.getByTestId('stream')).toHaveAttribute('data-borderless', 'true');
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
    rerender(<VoiceGrid participants={[]} fullscreen chromeRevealed />);
    await userEvent.click(screen.getByRole('button', { name: 'Show Members' }));
    expect(screen.getByText('Bob')).toBeInTheDocument();
    rerender(<VoiceGrid participants={[]} fullscreen chromeRevealed={false} />);
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
  });
});
