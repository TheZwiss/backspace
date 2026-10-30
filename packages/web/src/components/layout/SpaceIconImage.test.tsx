import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));
vi.mock('../../utils/staticAvatar', () => ({ useStaticAvatar: (src: string, animate: boolean) => animate ? src : 'data:image/png;still' }));
import { SpaceIconImage } from './SpaceSidebar';

describe('server icon animation', () => {
  it('shows the still until hovered and freezes again when the pointer leaves', () => {
    render(<SpaceIconImage icon="cat.gif" alt="Server" className="icon" />);
    const image = screen.getByAltText('Server');
    expect(image.getAttribute('src')).toBe('data:image/png;still');
    fireEvent.mouseEnter(image);
    expect(image.getAttribute('src')).toBe('/api/uploads/cat.gif');
    fireEvent.mouseLeave(image);
    expect(image.getAttribute('src')).toBe('data:image/png;still');
  });
});
