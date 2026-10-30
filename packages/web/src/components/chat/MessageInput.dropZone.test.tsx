import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@backspace/shared';
import { useAuthStore } from '../../stores/authStore';
import { useComposerStore } from '../../stores/composerStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useTransferStore } from '../../stores/transferStore';
import { MessageInput } from './MessageInput';

vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn() }));
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

const me = {
  id: 'me',
  username: 'alice',
  displayName: 'Alice',
  avatar: null,
  createdAt: 1,
  replicatedInstances: [],
} as unknown as User;

const startUpload = vi.fn();

/** The chat region is the composer's parent, as in MainContent. */
function renderInRegion() {
  const view = render(
    <div data-testid="region" style={{ position: 'relative' }}>
      <div data-testid="messages">messages</div>
      <MessageInput channelId="dm-1" channelName="@Bob" />
    </div>,
  );
  return { ...view, region: view.getByTestId('region') };
}

function fileDrag(files: File[] = []) {
  return { types: ['Files'], files, items: [] };
}

beforeEach(() => {
  startUpload.mockReset().mockResolvedValue('transfer-1');
  useTransferStore.setState({ transfers: new Map(), startUpload });
  window.history.replaceState({}, '', '/channels/@me/dm-1');
  useAuthStore.setState({ user: me });
  useSpaceStore.getState().reset();
  useSpaceStore.getState().populateFromReady('', [], [], [{ id: 'dm-1', federatedId: null, createdAt: 1, members: [me] }]);
  useComposerStore.setState({ states: new Map() });
});

afterEach(() => {
  cleanup();
  useComposerStore.setState({ states: new Map() });
  useAuthStore.setState({ user: null });
  useSpaceStore.getState().reset();
  window.history.replaceState({}, '', '/');
});

describe('MessageInput file drop zone', () => {
  it('shows the labelled overlay over the whole region while files are dragged in, and removes it on leave', () => {
    const { region } = renderInRegion();
    expect(screen.queryByTestId('chat-drop-overlay')).toBeNull();

    fireEvent.dragEnter(region, { dataTransfer: fileDrag() });
    const overlay = screen.getByTestId('chat-drop-overlay');
    expect(overlay.parentElement).toBe(region);
    expect(overlay).toHaveTextContent('Upload file');

    fireEvent.dragLeave(region, { dataTransfer: fileDrag() });
    expect(screen.queryByTestId('chat-drop-overlay')).toBeNull();
  });

  it('shows no overlay for a text drag (selected text, in-app drags)', () => {
    const { region } = renderInRegion();
    fireEvent.dragEnter(region, { dataTransfer: { types: ['text/plain'], files: [], items: [] } });
    expect(screen.queryByTestId('chat-drop-overlay')).toBeNull();
  });

  it('attaches a file dropped on the messages area (outside the input pill) and stages it', async () => {
    const { region } = renderInRegion();
    const file = new File(['x'], 'photo.png', { type: 'image/png' });

    fireEvent.dragEnter(region, { dataTransfer: fileDrag([file]) });
    fireEvent.drop(screen.getByTestId('messages'), { dataTransfer: fileDrag([file]) });

    expect(screen.queryByTestId('chat-drop-overlay')).toBeNull();
    expect(startUpload).toHaveBeenCalledTimes(1);
    expect(startUpload).toHaveBeenCalledWith(file, expect.objectContaining({ channelId: 'dm-1', tray: true }));
    await vi.waitFor(() => {
      expect(useComposerStore.getState().get('dm-1').stagedTransferIds).toEqual(['transfer-1']);
    });
  });

  it('attaches each dropped file exactly once when dropped on the input itself', () => {
    renderInRegion();
    const files = [
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.mp4', { type: 'video/mp4' }),
    ];

    fireEvent.drop(screen.getByRole('textbox'), { dataTransfer: fileDrag(files) });

    expect(startUpload).toHaveBeenCalledTimes(2);
  });
});
