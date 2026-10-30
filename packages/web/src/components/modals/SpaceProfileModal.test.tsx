import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const data = vi.hoisted(() => ({ spaces: [
  { id: 'current', name: 'Current server', icon: null, banner: null, avatarColor: null, createdAt: 1000 },
  { id: 'target', name: 'Remote server', icon: 'icon.gif', banner: '/api/uploads/banner.gif', description: 'Server description', avatarColor: null, createdAt: 1000, _instanceOrigin: 'https://peer.example' },
] }));
vi.mock('../../stores/spaceStore', () => ({
  useSpaceStore: (selector: (state: unknown) => unknown) => selector(data),
  getApiForOrigin: (origin: string) => ({ uploads: { url: (name: string) => `${origin}/api/uploads/${name}` } }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'pt-BR' } }) }));
import { useUIStore } from '../../stores/uiStore';
import { SpaceProfileModal } from './SpaceProfileModal';
afterEach(() => useUIStore.getState().closeModal());
describe('server profile', () => {
  it('opens the selected server and preserves animated assets from its own instance', () => {
    useUIStore.getState().openModal('spaceProfile', { spaceId: 'target' });
    render(<SpaceProfileModal />);
    expect(screen.getByText('Remote server')).toBeTruthy();
    expect(screen.queryByText('Current server')).toBeNull();
    expect(screen.getByAltText('Remote server').getAttribute('src')).toBe('https://peer.example/api/uploads/icon.gif');
    expect(screen.getByText('Server description')).toBeTruthy();
    fireEvent.click(screen.getByTitle('spaces:profile.viewBanner'));
    expect(screen.getByAltText('spaces:profile.viewBanner').getAttribute('src')).toBe('https://peer.example/api/uploads/banner.gif');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByText('Remote server')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useUIStore.getState().activeModal).toBeNull();
  });
  it('renders a fallback when there is no icon or banner', () => {
    useUIStore.getState().openModal('spaceProfile', { spaceId: 'current' });
    render(<SpaceProfileModal />);
    expect(screen.getByText('Current server')).toBeTruthy();
    expect(screen.getByText('spaces:profile.noDescription')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
