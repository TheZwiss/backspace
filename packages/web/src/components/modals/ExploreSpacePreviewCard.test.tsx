import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom.
// Reached transitively via exploreStore → spaceStore → chatStore → useWebSocket → voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

import { ExploreSpacePreviewCard } from './ExploreSpacePreviewCard';
import { useExploreStore, type TaggedExploreSpace } from '../../stores/exploreStore';

function makeSpace(overrides: Partial<TaggedExploreSpace> = {}): TaggedExploreSpace {
  return {
    id: 's1', name: 'Design Guild', icon: null, banner: null, avatarColor: null,
    description: null, visibility: 'public', memberCount: 5, createdAt: 0,
    joined: false, _instanceOrigin: '', ...overrides,
  };
}

beforeEach(() => {
  useExploreStore.setState({
    myRequests: [],
    publicJoin: vi.fn().mockResolvedValue({ id: 's1', name: 'Design Guild' }),
    requestJoin: vi.fn().mockResolvedValue({ id: 'r1', spaceId: 's1', status: 'pending' }),
  });
});

describe('ExploreSpacePreviewCard', () => {
  it('renders name, member count and a Join button for public spaces', () => {
    render(<ExploreSpacePreviewCard space={makeSpace()} onJoinSuccess={vi.fn()} />);
    expect(screen.getByText('Design Guild')).toBeInTheDocument();
    expect(screen.getByText(/5 members/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /join/i })).toBeInTheDocument();
  });

  it('joins a public space and reports success', async () => {
    const user = userEvent.setup();
    const onJoinSuccess = vi.fn();
    render(<ExploreSpacePreviewCard space={makeSpace()} onJoinSuccess={onJoinSuccess} />);
    await user.click(screen.getByRole('button', { name: /join/i }));
    await waitFor(() => expect(onJoinSuccess).toHaveBeenCalledWith('s1'));
  });

  it('shows Request for request-visibility spaces', () => {
    render(<ExploreSpacePreviewCard space={makeSpace({ visibility: 'request' })} onJoinSuccess={vi.fn()} />);
    expect(screen.getByRole('button', { name: /request/i })).toBeInTheDocument();
  });
});
