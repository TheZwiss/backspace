import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { User } from '@backspace/shared';

import { ProfileAvatar } from './ProfileAvatar';
import { useUIStore } from '../../stores/uiStore';

function makeUser(): User {
  return {
    id: 'u-1',
    username: 'ada',
    displayName: 'Ada',
    avatar: null,
    banner: null,
    accentColor: null,
    avatarColor: null,
    bio: null,
    status: 'online',
    customStatus: null,
    isAdmin: false,
    createdAt: 0,
    homeInstance: null,
    homeUserId: null,
    replicatedInstances: [],
  };
}

function stubRect(el: Element, rect: Partial<DOMRect>) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
    toJSON: () => ({}), ...rect,
  } as DOMRect);
}

describe('ProfileAvatar', () => {
  beforeEach(() => {
    useUIStore.setState({
      isMobile: false,
      userProfilePopout: { user: null, anchor: null, placement: 'right' },
    });
  });

  it('opens the profile popout anchored to its own box', async () => {
    const { container } = render(<ProfileAvatar user={makeUser()} name="Ada" size={40} />);
    const el = container.querySelector('[data-avatar]')!;
    stubRect(el, { top: 200, left: 100, right: 140, bottom: 240, width: 40, height: 40 });

    await userEvent.click(el);

    const popout = useUIStore.getState().userProfilePopout;
    expect(popout.user).toMatchObject({ id: 'u-1' });
    expect(popout.anchor).toMatchObject({ top: 200, left: 100, right: 140, bottom: 240 });
    expect(popout.placement).toBe('right');
  });

  it('honours an explicit placement so callers do not hand-roll offsets', async () => {
    const { container } = render(<ProfileAvatar user={makeUser()} name="Ada" size={40} placement="left" />);
    const el = container.querySelector('[data-avatar]')!;
    stubRect(el, { top: 10, left: 900, right: 940, bottom: 50, width: 40, height: 40 });

    await userEvent.click(el);

    expect(useUIStore.getState().userProfilePopout.placement).toBe('left');
  });

  it('degrades to a plain avatar when the user behind it is unknown', async () => {
    // Voice tiles and DM intros render before the user record has resolved.
    const { container } = render(<ProfileAvatar user={undefined} name="?" size={40} />);
    const el = container.querySelector('[data-avatar]')!;

    await userEvent.click(el);

    expect(useUIStore.getState().userProfilePopout.user).toBeNull();
    expect(el.className).not.toContain('cursor-pointer');
  });

  it('stops the click from reaching an enclosing row handler', async () => {
    let rowClicks = 0;
    const { container } = render(
      <div onClick={() => { rowClicks++; }}>
        <ProfileAvatar user={makeUser()} name="Ada" size={40} />
      </div>,
    );
    const el = container.querySelector('[data-avatar]')!;
    stubRect(el, { top: 0, left: 0, right: 40, bottom: 40, width: 40, height: 40 });

    await userEvent.click(el);

    expect(rowClicks).toBe(0);
  });
});
