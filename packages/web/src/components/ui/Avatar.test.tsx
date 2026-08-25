import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { User } from '@backspace/shared';

import { Avatar } from './Avatar';
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

describe('Avatar', () => {
  beforeEach(() => {
    useUIStore.setState({
      isMobile: false,
      userProfilePopout: { user: null, anchor: null, placement: 'right' },
    });
  });

  it('is presentational: a `user` prop alone does not make it a profile trigger', async () => {
    // `user` carries identity for the gradient, colour and status dot. Passing it
    // must not silently turn the avatar into a popout trigger — otherwise every
    // avatar inside a modal, settings preview or the profile card itself opens a
    // second profile card on top of the surface it lives in (issue #37).
    const { container } = render(<Avatar src={null} name="Ada" size={40} user={makeUser()} />);

    await userEvent.click(container.querySelector('[data-avatar]')!);

    expect(useUIStore.getState().userProfilePopout.user).toBeNull();
  });

  it('is not focusable or clickable-looking without a handler', () => {
    const { container } = render(<Avatar src={null} name="Ada" size={40} user={makeUser()} />);

    expect(container.querySelector('[data-avatar]')!.className).not.toContain('cursor-pointer');
  });

  it('runs an explicit onClick handler', async () => {
    let clicks = 0;
    const { container } = render(<Avatar src={null} name="Ada" size={40} user={makeUser()} onClick={() => { clicks++; }} />);

    await userEvent.click(container.querySelector('[data-avatar]')!);

    expect(clicks).toBe(1);
  });
});
