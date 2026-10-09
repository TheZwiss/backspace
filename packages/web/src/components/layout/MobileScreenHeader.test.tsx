import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../../i18n';
import { useUIStore } from '../../stores/uiStore';
import { MobileScreenHeader } from './MobileScreenHeader';

afterEach(async () => {
  cleanup();
  await setLanguage('en');
  useUIStore.setState({ mobileScreen: 'spaces', mobileStack: [] });
});

describe('MobileScreenHeader', () => {
  it.each([
    { language: 'en', label: 'Back' },
    { language: 'de', label: 'Zurück' },
    { language: 'ru', label: 'Назад' },
    { language: 'zh', label: '返回' },
    { language: 'pt', label: 'Voltar' },
  ] as const)('gives the back button an accessible name in $language', async ({ language, label }) => {
    await setLanguage(language);
    useUIStore.setState({ mobileScreen: 'dms', mobileStack: [{ screen: 'chat' }] });
    render(<MobileScreenHeader title="Conversation" />);

    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(useUIStore.getState().mobileScreen).toBe('dms');
    expect(useUIStore.getState().mobileStack).toEqual([]);
    expect(screen.getByRole('heading', { name: 'Conversation' })).toBeInTheDocument();
  });

  it('updates the accessible name when the language changes', async () => {
    render(<MobileScreenHeader title="Conversation" />);
    await act(() => setLanguage('zh'));
    expect(screen.getByRole('button', { name: '返回' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
  });
});
