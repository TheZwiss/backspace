import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { User } from '@backspace/shared';

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

import { setLanguage } from '../../i18n';
import { MentionBadge } from './MentionBadge';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';

const MIRA = { id: 'u-mira', username: 'mira', displayName: null, avatar: null, createdAt: 1 } as unknown as User;

afterEach(async () => {
  vi.restoreAllMocks();
  useSpaceStore.setState({ members: [], currentSpaceId: null });
  await setLanguage('en');
});

describe('MentionBadge', () => {
  it("names a user it cannot resolve in the reader's language (issue #313)", async () => {
    await setLanguage('de');
    render(<MentionBadge userId="u-gone" />);
    expect(screen.getByText('@Unbekannter Nutzer')).toBeInTheDocument();
  });

  it('opens the profile of a resolved member on click', () => {
    useSpaceStore.setState({
      members: [{ spaceId: 'space-1', userId: MIRA.id, nickname: null, joinedAt: 1, user: MIRA, roles: [] }],
      currentSpaceId: 'space-1',
    });
    const openUserProfile = vi.spyOn(useUIStore.getState(), 'openUserProfile').mockImplementation(() => {});
    render(<MentionBadge userId={MIRA.id} />);
    fireEvent.click(screen.getByText('@mira'));
    expect(openUserProfile).toHaveBeenCalledTimes(1);
  });
});
