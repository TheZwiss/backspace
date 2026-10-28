import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DmChannel, User } from '@backspace/shared';
vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));
vi.mock('../../hooks/useWebSocket', () => ({ getRejectedPeerOrigins: () => new Set(), getAwaitingApprovalPeerOrigins: () => new Set() }));
vi.mock('../../hooks/useDmViewer', () => ({ useDmViewer: () => ({ origin: '', self: {} }) }));
vi.mock('../../utils/userViewLookup', () => ({ useCanonicalUserView: (user: unknown) => user }));
vi.mock('../../utils/identity', () => ({ isMine: (user: User) => user.id === 'me', isFederationGlobeApplicable: () => false, userDisplayName: (user: User) => user.displayName }));
vi.mock('../ui/Avatar', () => ({ Avatar: () => null }));
import { DmListItem } from './DmListItem';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { useUIStore } from '../../stores/uiStore';
describe('private DM context menu', () => {
  it('opens a profile action for the conversation partner', () => {
    const friend = { id: 'friend', username: 'friend', displayName: 'Friend', homeInstance: null } as User;
    const me = { id: 'me', username: 'me' } as User;
    const dm = { id: 'dm', ownerId: null, members: [me, friend], lastMessage: null } as unknown as DmChannel;
    const open = vi.spyOn(useUIStore.getState(), 'openUserProfile').mockImplementation(() => {});
    render(<DmListItem dm={dm} user={me} isActive={false} isUnread={false} onSelect={vi.fn()} onClose={vi.fn()} onLeave={vi.fn()} />);
    fireEvent.contextMenu(screen.getByText('Friend'));
    const items = useContextMenuStore.getState().menu?.items ?? [];
    const profile = items.find(item => item.key === 'profile');
    expect(profile?.type).toBe('action');
    if (profile?.type === 'action') profile.onClick();
    expect(open).toHaveBeenCalledWith(friend, '', expect.anything(), 'right');
    open.mockRestore();
    useContextMenuStore.getState().close();
  });
});
