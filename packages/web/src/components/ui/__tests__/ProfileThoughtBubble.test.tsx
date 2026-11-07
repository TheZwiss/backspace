import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProfileThoughtBubble } from '../ProfileThoughtBubble';

const avatar = { avatarLeft: 20, avatarTop: -52, avatarSize: 96 };

describe('ProfileThoughtBubble', () => {
  it('draws nothing without a custom status', () => {
    const { container, rerender } = render(<ProfileThoughtBubble text={null} {...avatar} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ProfileThoughtBubble text="" {...avatar} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('puts the bubble right of the avatar, below the banner edge, leaving room on the right', () => {
    const { container } = render(<ProfileThoughtBubble text="compilando…" {...avatar} gap={50} top={6} rightGap={20} />);
    const bubble = screen.getByText('compilando…');
    expect(bubble.style.left).toBe('166px');
    expect(bubble.style.top).toBe('6px');
    expect(bubble.style.maxWidth).toBe('calc(100% - 186px)');
    expect(container.querySelector('[data-profile-thought-bubble]')).not.toBeNull();
  });

  it('runs two growing dots from the avatar edge to the bubble, never inside the avatar', () => {
    const { container } = render(<ProfileThoughtBubble text="oi" {...avatar} />);
    const dots = [...container.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')];
    expect(dots).toHaveLength(2);
    const [small, big] = dots.map((d) => ({ size: parseFloat(d.style.width), centerX: parseFloat(d.style.left) + parseFloat(d.style.width) / 2 }));
    expect(small!.size).toBeLessThan(big!.size);
    expect(small!.centerX).toBeLessThan(big!.centerX);
    const avatarRight = 20 + 96;
    expect(small!.centerX - small!.size / 2).toBeGreaterThan(avatarRight - 8);
    expect(big!.centerX + big!.size / 2).toBeLessThan(166);
  });

  it('scales an inner layer inside a clipped static box, so the pop never adds scrollable area to the card', () => {
    const { container } = render(<ProfileThoughtBubble text="oi" {...avatar} />);
    const outer = container.querySelector<HTMLElement>('[data-profile-thought-bubble]')!;
    expect(outer.className).toContain('overflow-hidden');
    expect(outer.className).not.toContain('motion-pop-in');
    expect(outer.querySelector('.motion-pop-in')).not.toBeNull();
  });

  it('grows out of the avatar edge', () => {
    const { container } = render(<ProfileThoughtBubble text="oi" {...avatar} />);
    const root = container.querySelector<HTMLElement>('.motion-pop-in')!;
    const [x, y] = root.style.transformOrigin.split(' ').map(parseFloat);
    expect(x).toBeCloseTo(20 + 48 + 48 * Math.cos(Math.PI / 12), 0);
    expect(y).toBeGreaterThan(0 - 52 + 48);
  });
});
