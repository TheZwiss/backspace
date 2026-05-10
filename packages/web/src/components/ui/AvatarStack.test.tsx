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

  it('renders triangular layout with three tiles and no +N for three members', () => {
    const { container } = render(
      <AvatarStack members={makeUsers(3)} size={40} border="channel" />
    );
    const tiles = container.querySelectorAll('[data-avatar-stack-tile]');
    expect(tiles.length).toBe(3);
    expect(container.querySelector('[data-avatar-stack-layout="triangle"]')).toBeTruthy();
    expect(container.querySelector('[data-avatar-stack-overflow]')).toBeFalsy();
  });

  it('renders diamond layout with four tiles and no +N for four members', () => {
    const { container } = render(
      <AvatarStack members={makeUsers(4)} size={40} border="channel" />
    );
    const tiles = container.querySelectorAll('[data-avatar-stack-tile]');
    expect(tiles.length).toBe(4);
    expect(container.querySelector('[data-avatar-stack-layout="diamond"]')).toBeTruthy();
    expect(container.querySelector('[data-avatar-stack-overflow]')).toBeFalsy();
  });

  it('renders three tiles + "+2" overflow in diamond layout for five members', () => {
    const { container } = render(
      <AvatarStack members={makeUsers(5)} size={40} border="channel" />
    );
    const tiles = container.querySelectorAll('[data-avatar-stack-tile]');
    expect(tiles.length).toBe(3);
    const overflow = container.querySelector('[data-avatar-stack-overflow]');
    expect(overflow).toBeTruthy();
    expect(overflow!.textContent).toBe('+2');
    expect(container.querySelector('[data-avatar-stack-layout="diamond"]')).toBeTruthy();
  });

  it('renders three tiles + "+7" overflow in diamond layout for ten members (cap)', () => {
    const { container } = render(
      <AvatarStack members={makeUsers(10)} size={40} border="channel" />
    );
    const tiles = container.querySelectorAll('[data-avatar-stack-tile]');
    expect(tiles.length).toBe(3);
    const overflow = container.querySelector('[data-avatar-stack-overflow]');
    expect(overflow).toBeTruthy();
    expect(overflow!.textContent).toBe('+7');
    expect(container.querySelector('[data-avatar-stack-layout="diamond"]')).toBeTruthy();
  });

  it('places tiles on the correct radial slots (3-member triangle)', () => {
    const { container } = render(
      <AvatarStack members={makeUsers(3)} size={40} border="channel" />,
    );
    const tiles = Array.from(
      container.querySelectorAll('[data-avatar-stack-tile]'),
    ) as HTMLElement[];
    // Triangle: top, bottom-right (~+30°), bottom-left (~+150° from -90 start)
    // Top tile must have the smallest `top` value.
    const tops = tiles.map((t) => parseInt(t.style.top, 10));
    const minTop = Math.min(...tops);
    expect(tops.filter((t) => t === minTop).length).toBe(1);
    // The two non-top tiles share roughly the same `top` (bottom row of triangle).
    const others = tops.filter((t) => t !== minTop).sort((a, b) => a - b);
    expect(others.length).toBe(2);
    expect(Math.abs(others[0]! - others[1]!)).toBeLessThanOrEqual(1);
  });

  it('places overflow tile in the bottom slot of the diamond', () => {
    const { container } = render(
      <AvatarStack members={makeUsers(5)} size={40} border="channel" />,
    );
    const overflow = container.querySelector(
      '[data-avatar-stack-overflow]',
    ) as HTMLElement;
    const tiles = Array.from(
      container.querySelectorAll('[data-avatar-stack-tile]'),
    ) as HTMLElement[];
    const overflowTop = parseInt(overflow.style.top, 10);
    // Overflow sits at bottom of diamond — its `top` should be the
    // largest among all four positioned elements.
    const tileTops = tiles.map((t) => parseInt(t.style.top, 10));
    expect(overflowTop).toBeGreaterThan(Math.max(...tileTops) - 1);
  });

  it('sizes the inner Avatar to the tile content area so contents stay centered', () => {
    // Regression for the off-center clipping bug: when the inner Avatar was
    // sized to the outer tile dimensions, `box-sizing: border-box` + 2px border
    // pushed its contents (image crop, initials gradient + letter) toward the
    // lower-right of the visible disc. The fix is to size the inner Avatar to
    // (tileSize − 2·border) and center it geometrically with flex.
    const { container } = render(
      <AvatarStack members={makeUsers(4)} size={80} border="chat" />,
    );
    const tiles = Array.from(
      container.querySelectorAll('[data-avatar-stack-tile]'),
    ) as HTMLElement[];
    expect(tiles.length).toBe(4);
    for (const tile of tiles) {
      // Tile is centered as a flex container so the Avatar bypasses inline-flow
      // baseline drift entirely.
      expect(tile.className).toMatch(/\bflex\b/);
      expect(tile.className).toMatch(/items-center/);
      expect(tile.className).toMatch(/justify-center/);
      // Inner Avatar is sized to (tileSize − 2·border) so it fits the padding
      // box exactly. With size=80 and tileRatio=0.58, tileSize=46 → inner=42.
      const tileSize = parseInt(tile.style.width, 10);
      const inner = tile.querySelector('[data-avatar]') as HTMLElement | null;
      expect(inner).toBeTruthy();
      expect(inner!.style.width).toBe(`${tileSize - 4}px`);
      expect(inner!.style.height).toBe(`${tileSize - 4}px`);
    }
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
