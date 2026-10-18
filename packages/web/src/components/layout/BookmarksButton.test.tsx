import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const { BookmarksButton } = await import('./BookmarksButton');
const { useUIStore } = await import('../../stores/uiStore');

beforeEach(() => useUIStore.getState().closeModal());

describe('BookmarksButton', () => {
  it('opens the bookmarks window', () => {
    render(<BookmarksButton />);
    const button = screen.getByRole('button', { name: 'title' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(useUIStore.getState().activeModal).toBe('bookmarks');
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });
});
