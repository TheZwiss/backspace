import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { StrikeLine } from '../StrikeLine';
import { PresenceIndicator } from '../PresenceIndicator';
import { BookmarkIcon } from '../BookmarkIcon';
import { UnreadCountBadge } from '../../layout/UnreadCountBadge';

describe('StrikeLine', () => {
  it('stays mounted in both states so it can draw in and retract', () => {
    const { container, rerender } = render(<svg viewBox="0 0 24 24"><StrikeLine active={false} /></svg>);
    const line = container.querySelector('line.strike-line');
    expect(line).not.toBeNull();
    expect(line).toHaveAttribute('data-active', 'false');
    rerender(<svg viewBox="0 0 24 24"><StrikeLine active /></svg>);
    expect(container.querySelector('line.strike-line')).toBe(line);
    expect(line).toHaveAttribute('data-active', 'true');
  });

  it('spans the box minus the inset, normalised for the dash animation', () => {
    const { container } = render(<svg viewBox="0 0 24 24"><StrikeLine active inset={2} /></svg>);
    const line = container.querySelector('line')!;
    expect(line).toHaveAttribute('x1', '2');
    expect(line).toHaveAttribute('x2', '22');
    expect(line).toHaveAttribute('pathLength', '1');
  });
});

describe('PresenceIndicator', () => {
  it('draws the status it mounted with still, and morphs a live change in', () => {
    const { container, rerender } = render(<PresenceIndicator status="online" />);
    expect(container.querySelector('.motion-presence-swap')).toBeNull();
    rerender(<PresenceIndicator status="idle" />);
    expect(container.querySelector('.motion-presence-swap')).not.toBeNull();
    expect(container.querySelector('svg')).toHaveClass('text-status-idle');
  });
});

describe('BookmarkIcon', () => {
  it('keeps one filled path and fades its opacity between the states', () => {
    const { container, rerender } = render(<BookmarkIcon />);
    const path = container.querySelector('path.bookmark-fill');
    expect(path).toHaveAttribute('fill-opacity', '0');
    rerender(<BookmarkIcon filled />);
    expect(container.querySelector('path.bookmark-fill')).toBe(path);
    expect(path).toHaveAttribute('fill-opacity', '1');
  });
});

describe('UnreadCountBadge', () => {
  const badge = (container: HTMLElement) => container.querySelector('[aria-hidden="true"]');

  it('pops in on arrival, bumps when the count rises and settles when it falls', () => {
    const { container, rerender } = render(<UnreadCountBadge count={2} label="2 unread" />);
    expect(badge(container)).toHaveClass('motion-pop-in');
    rerender(<UnreadCountBadge count={3} label="3 unread" />);
    expect(badge(container)).toHaveClass('motion-bump');
    expect(badge(container)).toHaveTextContent('3');
    rerender(<UnreadCountBadge count={1} label="1 unread" />);
    expect(badge(container)).not.toHaveClass('motion-bump');
    expect(badge(container)).not.toHaveClass('motion-pop-in');
  });
});
