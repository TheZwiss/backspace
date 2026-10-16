import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  addToast: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../api/client', () => ({ api: { users: { update: mocks.update } } }));
vi.mock('../../../stores/uiStore', () => ({
  useUIStore: (selector: (s: { addToast: typeof mocks.addToast }) => unknown) => selector({ addToast: mocks.addToast }),
}));

import { DeveloperPanel } from './DeveloperPanel';
import { useDeveloperModeStore } from '../../../stores/developerModeStore';

const toggle = () => screen.getByRole('switch', { name: 'settings:developer.mode.label' });

describe('DeveloperPanel', () => {
  beforeEach(() => {
    mocks.update.mockReset();
    mocks.addToast.mockReset();
    useDeveloperModeStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
    useDeveloperModeStore.getState().reset();
  });

  it('stores the switch on the account, then shows what the server answered', async () => {
    mocks.update.mockResolvedValue({ developerMode: true });
    render(<DeveloperPanel />);
    expect(toggle()).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle());

    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'));
    expect(mocks.update).toHaveBeenCalledWith({ developerMode: true });
    expect(useDeveloperModeStore.getState().enabled).toBe(true);
  });

  it('leaves the switch where it was and says so when the server refuses', async () => {
    mocks.update.mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<DeveloperPanel />);

    fireEvent.click(toggle());

    await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith('settings:developer.mode.saveFailed', 'warning', 4000));
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
    expect(useDeveloperModeStore.getState().enabled).toBe(false);
  });

  it('shows the value another device stored', () => {
    useDeveloperModeStore.getState().setEnabled(true);
    render(<DeveloperPanel />);
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
  });
});
