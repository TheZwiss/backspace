import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DmChannel, MemberWithUser, Role, User } from '@backspace/shared';

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
const KAI = { id: 'u-kai', username: 'kai', displayName: 'Kai', avatar: null, createdAt: 1 } as unknown as User;
const ME = { id: 'u-me', username: 'quddy', displayName: null, avatar: null, createdAt: 1 } as unknown as User;
const ZED_STUB = { id: 'u-zed', username: 'zed@orbit.example', displayName: null, avatar: null, createdAt: 1 } as unknown as User;
const DM = { id: 'dm-1', ownerId: null, createdAt: 1, members: [ME, KAI, ZED_STUB], lastMessage: null } as unknown as DmChannel;
const RED_ROLE = { id: 'r-1', spaceId: 'space-1', name: 'Red', color: '#ff0000', position: 1 } as unknown as Role;

function member(spaceId: string, user: User, roles: Role[] = []): MemberWithUser {
  return { spaceId, userId: user.id, nickname: null, joinedAt: 1, user, roles };
}

afterEach(async () => {
  vi.restoreAllMocks();
  useSpaceStore.setState({
    members: [],
    currentSpaceId: null,
    dmChannels: [],
    channelToSpaceMap: new Map(),
  });
  await setLanguage('en');
});

describe('MentionBadge', () => {
  it("names a user it cannot resolve in the reader's language (issue #313)", async () => {
    await setLanguage('de');
    render(<MentionBadge userId="u-gone" channelId="chan-1" />);
    expect(screen.getByText('@Unbekannter Nutzer')).toBeInTheDocument();
  });

  it('opens the profile of a resolved member on click', () => {
    useSpaceStore.setState({
      members: [member('space-1', MIRA)],
      channelToSpaceMap: new Map([['chan-1', 'space-1']]),
      currentSpaceId: 'space-1',
    });
    const openUserProfile = vi.spyOn(useUIStore.getState(), 'openUserProfile').mockImplementation(() => {});
    render(<MentionBadge userId={MIRA.id} channelId="chan-1" />);
    fireEvent.click(screen.getByText('@mira'));
    expect(openUserProfile).toHaveBeenCalledTimes(1);
    expect(openUserProfile.mock.calls[0]![4]).toEqual({ spaceId: 'space-1', userId: MIRA.id });
  });
});

describe('MentionBadge in a DM (#338)', () => {
  it('resolves a DM member when no space roster is loaded (fresh start on a DM)', () => {
    useSpaceStore.setState({ dmChannels: [DM], members: [] });
    render(<MentionBadge userId={KAI.id} channelId={DM.id} />);
    expect(screen.getByText('@Kai')).toBeInTheDocument();
  });

  it('does not resolve a DM mention from the roster of the space opened last', () => {
    const LONE_DM = { ...DM, members: [ME] } as DmChannel;
    useSpaceStore.setState({ dmChannels: [LONE_DM], members: [member('space-1', KAI)] });
    render(<MentionBadge userId={KAI.id} channelId={DM.id} />);
    expect(screen.getByText('@Unknown User')).toBeInTheDocument();
  });

  it('uses the accent colour in a DM, never a role colour from a loaded space roster', () => {
    useSpaceStore.setState({ dmChannels: [DM], members: [member('space-1', KAI, [RED_ROLE])] });
    render(<MentionBadge userId={KAI.id} channelId={DM.id} />);
    expect(screen.getByText('@Kai')).toHaveStyle({ color: '#7c6cf6' });
  });

  it('opens the profile without a space member context in a DM', () => {
    useSpaceStore.setState({ dmChannels: [DM] });
    const openUserProfile = vi.spyOn(useUIStore.getState(), 'openUserProfile').mockImplementation(() => {});
    render(<MentionBadge userId={KAI.id} channelId={DM.id} />);
    fireEvent.click(screen.getByText('@Kai'));
    expect(openUserProfile).toHaveBeenCalledTimes(1);
    expect(openUserProfile.mock.calls[0]![4]).toBeUndefined();
  });
});

describe('MentionBadge in a space channel', () => {
  it("resolves only against that channel's space, not a roster loaded for another space", () => {
    useSpaceStore.setState({
      channelToSpaceMap: new Map([['chan-1', 'space-1']]),
      members: [member('space-2', KAI)],
      currentSpaceId: 'space-2',
    });
    render(<MentionBadge userId={KAI.id} channelId="chan-1" />);
    expect(screen.getByText('@Unknown User')).toBeInTheDocument();
  });

  it('shows the highest role colour of the member in that space', () => {
    useSpaceStore.setState({
      channelToSpaceMap: new Map([['chan-1', 'space-1']]),
      members: [member('space-1', KAI, [RED_ROLE])],
      currentSpaceId: 'space-1',
    });
    render(<MentionBadge userId={KAI.id} channelId="chan-1" />);
    expect(screen.getByText('@Kai')).toHaveStyle({ color: '#ff0000' });
  });

  it("names a member without a display name by the base of the username, as the DM list and header do", () => {
    useSpaceStore.setState({ dmChannels: [DM] });
    render(<MentionBadge userId={ZED_STUB.id} channelId={DM.id} />);
    expect(screen.getByText('@zed')).toBeInTheDocument();
  });
});

describe('MentionBadge from the keyboard (#329)', () => {
  function seedMira(): void {
    useSpaceStore.setState({
      members: [member('space-1', MIRA)],
      channelToSpaceMap: new Map([['chan-1', 'space-1']]),
      currentSpaceId: 'space-1',
    });
  }

  it('is a button a keyboard user can reach and activate', async () => {
    seedMira();
    const openUserProfile = vi.spyOn(useUIStore.getState(), 'openUserProfile').mockImplementation(() => {});
    render(<MentionBadge userId={MIRA.id} channelId="chan-1" />);
    const badge = screen.getByRole('button', { name: '@mira' });

    await userEvent.tab();
    expect(badge).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(openUserProfile).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(' ');
    expect(openUserProfile).toHaveBeenCalledTimes(2);
  });

  it('is plain text when there is no profile to open', () => {
    render(<MentionBadge userId="u-gone" channelId="chan-1" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('@Unknown User').className).not.toContain('cursor-pointer');
  });

  it('is plain text inside another control', () => {
    seedMira();
    render(<MentionBadge userId={MIRA.id} channelId="chan-1" interactive={false} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
