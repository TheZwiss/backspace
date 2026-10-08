import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom.
// Reached transitively via the stores.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HttpError } from '../../api/client';
import { useContextMenuStore, type ContextMenuAction } from '../../stores/contextMenuStore';
import { useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { MobileSpacesScreen } from './MobileSpacesScreen';

const SPACE: TaggedSpace = {
  id: 'space-1',
  name: 'Kobold',
  icon: null,
  banner: null,
  avatarColor: null,
  ownerId: 'someone-else',
  inviteCode: null,
  visibility: 'request',
  directoryListed: false,
  description: null,
  createdAt: 0,
  _instanceOrigin: '',
};

const realGenerateInvite = useSpaceStore.getState().generateInvite;
const writeText = vi.fn<(text: string) => Promise<void>>();

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={['/channels/@me']}>
      <MobileSpacesScreen />
    </MemoryRouter>,
  );
}

function openSpaceMenu(container: HTMLElement): void {
  const button = container.querySelector('button[data-context-menu]');
  if (!button) throw new Error('space rail has no space button');
  fireEvent.contextMenu(button);
}

function menuAction(key: string): ContextMenuAction {
  const item = useContextMenuStore.getState().menu?.items.find((i) => i.key === key);
  if (!item || item.type !== 'action') throw new Error(`space menu has no "${key}" action`);
  return item;
}

function lastToast(): { message: string; type: string } | undefined {
  return useUIStore.getState().toasts.at(-1);
}

beforeEach(() => {
  useSpaceStore.setState({
    spaces: [SPACE],
    currentSpaceId: null,
    lastSelectedSpaceId: null,
    channels: [],
    dmChannels: [],
    folders: [],
    spaceLayout: [{ t: 's', id: SPACE.id }],
  });
  useUIStore.setState({ isMobile: true, toasts: [] });
  useContextMenuStore.getState().close();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => {
  useSpaceStore.setState({ generateInvite: realGenerateInvite });
});

describe('MobileSpacesScreen space menu: Invite People', () => {
  it('shows the server reason when the space is joined by request', async () => {
    useSpaceStore.setState({
      generateInvite: vi.fn().mockRejectedValue(
        new HttpError(403, 'This space uses join requests', undefined, 'space_uses_join_requests'),
      ),
    });
    const { container } = renderScreen();
    openSpaceMenu(container);
    await act(async () => { menuAction('invite').onClick(); });
    await waitFor(() => expect(lastToast()?.message).toBe('This space is joined by request, so it has no invite links.'));
    expect(lastToast()?.type).toBe('warning');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('keeps the generic text when the failure has no code', async () => {
    useSpaceStore.setState({ generateInvite: vi.fn().mockRejectedValue(new HttpError(502, 'Bad Gateway')) });
    const { container } = renderScreen();
    openSpaceMenu(container);
    await act(async () => { menuAction('invite').onClick(); });
    await waitFor(() => expect(lastToast()?.message).toBe('Failed to generate invite'));
  });

  it('keeps the generic text when the clipboard write fails', async () => {
    useSpaceStore.setState({ generateInvite: vi.fn().mockResolvedValue('abc123') });
    writeText.mockRejectedValue(new DOMException('Document is not focused.', 'NotAllowedError'));
    const { container } = renderScreen();
    openSpaceMenu(container);
    await act(async () => { menuAction('invite').onClick(); });
    await waitFor(() => expect(lastToast()?.message).toBe('Failed to generate invite'));
  });
});
