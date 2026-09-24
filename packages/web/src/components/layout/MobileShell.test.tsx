import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { InstanceInfoResponse } from '@backspace/shared';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom.
// Reached transitively via the voice screens and stores.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../../api/client';
import { __resetHomeInstanceInfoForTests } from '../../hooks/useHomeInstanceInfo';
import { mobileScreenMap } from './MobileShell';

beforeEach(() => {
  __resetHomeInstanceInfoForTests();
  vi.spyOn(api.instance, 'info').mockReturnValue(new Promise<InstanceInfoResponse>(() => {}));
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetHomeInstanceInfoForTests();
});

describe('MobileShell: backspace screen', () => {
  it('renders the Backspace page under the mobile header, without the page top bar', () => {
    const renderScreen = mobileScreenMap['backspace'];
    expect(renderScreen).toBeDefined();

    render(<MemoryRouter>{renderScreen?.()}</MemoryRouter>);

    const headings = screen.getAllByRole('heading', { level: 1, name: 'Backspace' });
    // The mobile header's title, then the page's own heading.
    expect(headings).toHaveLength(2);
    expect(headings[0]?.closest('header')?.querySelector('button')).not.toBeNull();
    expect(screen.getByText('Open-source chat you can host yourself.')).toBeInTheDocument();
    // The page's top bar is the only place the member-list toggle lives.
    expect(screen.queryByRole('button', { name: 'Toggle Member List' })).toBeNull();
  });

  it('gives the page only the height the header leaves', () => {
    render(<MemoryRouter>{mobileScreenMap['backspace']?.()}</MemoryRouter>);

    // jsdom does no layout, so this pins the structure: the page's root is
    // `h-full`, and only a `flex-1 min-h-0` parent keeps that from resolving
    // to the whole screen and pushing the page's end under the stack's clip.
    const pageHeading = screen.getAllByRole('heading', { level: 1, name: 'Backspace' })[1];
    const pageRoot = pageHeading?.closest('.bg-surface-chat');
    expect(pageRoot).not.toBeNull();
    expect(pageRoot?.parentElement).toHaveClass('flex-1', 'min-h-0', 'flex', 'flex-col');
  });
});
