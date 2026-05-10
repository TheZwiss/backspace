import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { User } from '@backspace/shared';

// AvatarStack pulls in `useCanonicalUserView` → spaceStore, which transitively
// imports AudioManager. Stub it out so jsdom doesn't choke on AudioWorkletNode.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

import { AvatarStack } from './AvatarStack';

function makeUser(n: number): User {
  return {
    id: `u-${n}`,
    username: `user${n}`,
    displayName: `User ${n}`,
    avatar: null,
    banner: null,
    accentColor: null,
    avatarColor: null,
    bio: null,
    status: 'offline',
    customStatus: null,
    isAdmin: false,
    createdAt: 0,
    homeInstance: null,
    homeUserId: null,
    replicatedInstances: [],
  };
}

function makeUsers(count: number): User[] {
  return Array.from({ length: count }, (_, i) => makeUser(i + 1));
}

describe('AvatarStack', () => {
  it('renders empty placeholder + group badge for an empty group', () => {
    const { container } = render(
      <AvatarStack members={[]} size={40} border="channel" />
    );
    // Placeholder slot present
    expect(container.querySelector('[data-avatar-stack-placeholder]')).toBeTruthy();
    // Group badge present
    expect(container.querySelector('[data-group-badge]')).toBeTruthy();
    // No avatar tiles rendered
    expect(container.querySelectorAll('[data-avatar-stack-tile]').length).toBe(0);
    // No +N tile
    expect(container.querySelector('[data-avatar-stack-overflow]')).toBeFalsy();
  });

  it('renders centered avatar + 12x12 group badge for a single member', () => {
    const { container } = render(
      <AvatarStack members={makeUsers(1)} size={40} border="channel" />
    );
    const tiles = container.querySelectorAll('[data-avatar-stack-tile]');
    expect(tiles.length).toBe(1);
    const badge = container.querySelector('[data-group-badge]') as HTMLElement | null;
    expect(badge).toBeTruthy();
    expect(badge!.getAttribute('data-group-badge')).toBe('true');
    // Badge is sized 12x12
    const badgeStyle = badge!.style;
    expect(badgeStyle.width).toBe('12px');
    expect(badgeStyle.height).toBe('12px');
    // No +N
    expect(container.querySelector('[data-avatar-stack-overflow]')).toBeFalsy();
  });

  it('renders two avatars in offset overlap for two members', () => {
    const { container } = render(
      <AvatarStack members={makeUsers(2)} size={40} border="channel" />
    );
    const tiles = container.querySelectorAll('[data-avatar-stack-tile]');
    expect(tiles.length).toBe(2);
    // No group badge in multi-member case
    expect(container.querySelector('[data-group-badge]')).toBeFalsy();
    // Layout marker for overlap
    expect(container.querySelector('[data-avatar-stack-layout="overlap"]')).toBeTruthy();
    // No +N
    expect(container.querySelector('[data-avatar-stack-overflow]')).toBeFalsy();
  });

  it('renders 2x2 grid with three tiles and no +N for three members', () => {
    const { container } = render(
      <AvatarStack members={makeUsers(3)} size={40} border="channel" />
    );
    const tiles = container.querySelectorAll('[data-avatar-stack-tile]');
    expect(tiles.length).toBe(3);
    expect(container.querySelector('[data-avatar-stack-layout="grid"]')).toBeTruthy();
    expect(container.querySelector('[data-avatar-stack-overflow]')).toBeFalsy();
  });

  it('renders three tiles + "+2" overflow for five members', () => {
    const { container } = render(
      <AvatarStack members={makeUsers(5)} size={40} border="channel" />
    );
    const tiles = container.querySelectorAll('[data-avatar-stack-tile]');
    expect(tiles.length).toBe(3);
    const overflow = container.querySelector('[data-avatar-stack-overflow]');
    expect(overflow).toBeTruthy();
    expect(overflow!.textContent).toBe('+2');
    expect(container.querySelector('[data-avatar-stack-layout="grid"]')).toBeTruthy();
  });

  it('renders three tiles + "+7" overflow for ten members (cap)', () => {
    const { container } = render(
      <AvatarStack members={makeUsers(10)} size={40} border="channel" />
    );
    const tiles = container.querySelectorAll('[data-avatar-stack-tile]');
    expect(tiles.length).toBe(3);
    const overflow = container.querySelector('[data-avatar-stack-overflow]');
    expect(overflow).toBeTruthy();
    expect(overflow!.textContent).toBe('+7');
  });

  it('renders icon override and ignores the stack', () => {
    const { container } = render(
      <AvatarStack
        members={makeUsers(3)}
        size={40}
        border="channel"
        iconUrl="abc.png"
      />
    );
    // Single img filling the box
    const imgs = container.querySelectorAll('img');
    expect(imgs.length).toBe(1);
    const img = imgs[0] as HTMLImageElement;
    // Bare filename → /api/uploads/ prefix
    expect(img.getAttribute('src')).toBe('/api/uploads/abc.png');
    // No tiles, no badge, no overflow
    expect(container.querySelectorAll('[data-avatar-stack-tile]').length).toBe(0);
    expect(container.querySelector('[data-group-badge]')).toBeFalsy();
    expect(container.querySelector('[data-avatar-stack-overflow]')).toBeFalsy();
  });

  it('uses absolute icon URL as-is for icon override', () => {
    const { container } = render(
      <AvatarStack
        members={[]}
        size={40}
        border="channel"
        iconUrl="https://example.com/icon.png"
      />
    );
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://example.com/icon.png');
  });
});
