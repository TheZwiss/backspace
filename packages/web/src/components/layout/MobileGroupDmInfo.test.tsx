import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DmChannel, User } from '@backspace/shared';

// ── Stubs for transitively-imported infra ──────────────────────────────────
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

// Replace the visual-viewport hook with a deterministic value — tests don't
// run real iOS keyboard transitions, but the bar must still mount and the
// `bottom` style must resolve.
vi.mock('../../hooks/useVisualViewportInset', () => ({
  useVisualViewportInset: () => ({
    value: 'env(safe-area-inset-bottom)',
    keyboardOpen: false,
    height: 800,
    offsetTop: 0,
  }),
}));

// Mock ImageCropModal — fires onCropComplete(blob) synchronously when the
// caller clicks the test "Confirm Crop" button (same pattern as
// GroupDmSettings.test.tsx, see commit cf292ac).
vi.mock('../ui/ImageCropModal', () => ({
  ImageCropModal: ({
    isOpen,
    onCropComplete,
    onClose,
  }: {
    isOpen: boolean;
    imageSrc: string;
    onCropComplete: (blob: Blob) => void;
    onClose: () => void;
    title?: string;
    cropShape?: 'rect' | 'round';
    aspectRatio?: number;
    maxOutputDimension?: number;
  }) => {
    if (!isOpen) return null;
    return (
      <div role="dialog" aria-label="cropper-mock">
        <button
          type="button"
          data-testid="cropper-mock-confirm"
          onClick={() =>
            onCropComplete(new Blob(['fake-image-bytes'], { type: 'image/webp' }))
          }
        >
          Confirm Crop
        </button>
        <button type="button" data-testid="cropper-mock-cancel" onClick={onClose}>
          Cancel Crop
        </button>
      </div>
    );
  },
}));

// Mock the api client — assert call counts on uploads + updateMetadata.
const mockUpdateMetadata = vi.fn();
const mockLeave = vi.fn();
const mockKickMember = vi.fn();
const mockTransferOwnership = vi.fn();
vi.mock('../../api/client', () => ({
  api: {
    dm: {
      updateMetadata: (...args: unknown[]) => mockUpdateMetadata(...args),
      leave: (...args: unknown[]) => mockLeave(...args),
      kickMember: (...args: unknown[]) => mockKickMember(...args),
      transferOwnership: (...args: unknown[]) => mockTransferOwnership(...args),
    },
    uploads: { url: (f: string) => `/api/uploads/${f}` },
  },
}));

// Global fetch spy — Cancel path must NEVER hit /api/uploads.
const fetchSpy = vi.fn();
beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue({
    ok: true,
    json: async () => ({ filename: 'unused.webp' }),
  } as Response);
  // @ts-expect-error overriding jsdom global
  global.fetch = fetchSpy;
});

// Mock transferStore — Save path goes through startUpload → waitForTransferAttachment.
const mockStartUpload = vi.fn();
vi.mock('../../stores/transferStore', () => ({
  useTransferStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({}),
    {
      getState: () => ({
        startUpload: (...args: unknown[]) => mockStartUpload(...args),
        transfers: new Map(),
      }),
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

const mockWaitForTransfer = vi.fn();
vi.mock('../../utils/waitForTransfer', () => ({
  waitForTransferAttachment: (...args: unknown[]) => mockWaitForTransfer(...args),
}));

// Stub cropImage so the real ImageCropModal apply path stays inert.
vi.mock('../../utils/cropImage', () => ({
  cropImage: vi.fn().mockResolvedValue(new Blob(['cropped'], { type: 'image/webp' })),
}));

// Spy on uiStore push/openModal so we can verify navigation/profile-screen
// pushes. We keep the real module live (the component reads several pieces
// of state directly) and just observe state transitions through `getState`.

import { MobileGroupDmInfo } from './MobileGroupDmInfo';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useSocialStore } from '../../stores/socialStore';
import { ContextMenuRenderer } from '../ui/ContextMenuRenderer';

// ── Fixtures ───────────────────────────────────────────────────────────────
function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-self',
    username: 'me',
    displayName: 'Me',
    avatar: null,
    banner: null,
    accentColor: null,
    avatarColor: null,
    bio: null,
    status: 'online',
    customStatus: null,
    isAdmin: false,
    createdAt: 0,
    homeInstance: null,
    homeUserId: null,
    replicatedInstances: [],
    ...overrides,
  };
}

function makeGroupDm(overrides: Partial<DmChannel> = {}): DmChannel {
  return {
    id: 'dm-1',
    federatedId: null,
    ownerId: 'user-self', // viewer is owner by default
    ownerHomeUserId: null,
    ownerHomeInstance: null,
    createdAt: 0,
    members: [
      makeUser({ id: 'user-self', username: 'me', displayName: 'Me' }),
      makeUser({ id: 'user-2', username: 'alice', displayName: 'Alice' }),
      makeUser({ id: 'user-3', username: 'bob', displayName: 'Bob' }),
    ],
    lastMessage: null,
    name: 'My Group',
    icon: null,
    metadataUpdatedAt: 0,
    ...overrides,
  };
}

function setStoreState(opts: { dmChannel: DmChannel; authUser: User | null }) {
  useSpaceStore.setState({
    dmChannels: [opts.dmChannel],
  } as Partial<ReturnType<typeof useSpaceStore.getState>>);
  useAuthStore.setState({ user: opts.authUser } as Partial<ReturnType<typeof useAuthStore.getState>>);
  useSocialStore.setState({ friends: [] } as Partial<ReturnType<typeof useSocialStore.getState>>);
}

beforeEach(() => {
  mockUpdateMetadata.mockReset();
  mockLeave.mockReset();
  mockKickMember.mockReset();
  mockTransferOwnership.mockReset();
  mockStartUpload.mockReset();
  mockWaitForTransfer.mockReset();
  mockUpdateMetadata.mockResolvedValue({});
  mockLeave.mockResolvedValue({ success: true });
  mockStartUpload.mockResolvedValue('transfer-1');
  mockWaitForTransfer.mockResolvedValue({ attachmentId: 'a-1', filename: 'icon-123.webp' });

  // Reset UI store entirely between tests so push/openModal call counts are clean.
  useUIStore.setState({
    activeModal: null,
    modalData: {},
    isMobile: true,
    toasts: [],
    mobileStack: [],
    mobileScreen: 'dms',
  });
});

function renderScreen() {
  // ContextMenuRenderer is needed so DmMemberRow long-press/kebab menus
  // actually mount their items into the DOM (the menu is portal-rendered).
  return render(
    <>
      <MobileGroupDmInfo params={{ channelId: 'dm-1' }} />
      <ContextMenuRenderer />
    </>,
  );
}

// ── Helper: drive a crop blob into the staged-icon state (matches the
// GroupDmSettings.test.tsx pattern). ──────────────────────────────────────
async function stageIcon(user: ReturnType<typeof userEvent.setup>) {
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  expect(fileInput).not.toBeNull();
  const file = new File(['raw'], 'pick.png', { type: 'image/png' });
  await act(async () => {
    fireEvent.change(fileInput, { target: { files: [file] } });
  });
  const confirmBtn = await screen.findByTestId('cropper-mock-confirm');
  await user.click(confirmBtn);
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'cropper-mock' })).toBeNull(),
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('MobileGroupDmInfo — edit toggle', () => {
  it('owner: clicking Edit swaps the name <h1> for an <input> and reveals the Save/Cancel bar', async () => {
    const user = userEvent.setup();
    const dm = makeGroupDm({ name: 'My Group' });
    setStoreState({ dmChannel: dm, authUser: makeUser({ id: 'user-self' }) });

    renderScreen();

    // Resting state: header heading is present, no input, no edit bar.
    expect(document.querySelector('[data-mobile-group-name]')).not.toBeNull();
    expect(document.querySelector('[data-mobile-group-name-input]')).toBeNull();
    expect(document.querySelector('[data-mobile-group-edit-bar]')).toBeNull();

    const editBtn = document.querySelector('[data-mobile-group-edit]') as HTMLButtonElement;
    expect(editBtn).not.toBeNull();
    await user.click(editBtn);

    // After click: input replaces heading and the edit bar mounts.
    expect(document.querySelector('[data-mobile-group-name]')).toBeNull();
    const nameInput = document.querySelector('[data-mobile-group-name-input]') as HTMLInputElement;
    expect(nameInput).not.toBeNull();
    expect(nameInput.value).toBe('My Group');
    expect(document.querySelector('[data-mobile-group-edit-bar]')).not.toBeNull();
  });

  it('non-owner: Edit button is not rendered', () => {
    const dm = makeGroupDm({ ownerId: 'user-2' }); // viewer NOT owner
    setStoreState({ dmChannel: dm, authUser: makeUser({ id: 'user-self' }) });

    renderScreen();

    expect(document.querySelector('[data-mobile-group-edit]')).toBeNull();
    // The name should be rendered as a heading, not an input.
    expect(document.querySelector('[data-mobile-group-name]')).not.toBeNull();
    expect(document.querySelector('[data-mobile-group-name-input]')).toBeNull();
  });
});

describe('MobileGroupDmInfo — save flows', () => {
  it('name-only edit: Save fires api.dm.updateMetadata with { name }', async () => {
    const user = userEvent.setup();
    const dm = makeGroupDm({ name: 'Old Name' });
    setStoreState({ dmChannel: dm, authUser: makeUser({ id: 'user-self' }) });

    renderScreen();

    await user.click(document.querySelector('[data-mobile-group-edit]') as HTMLButtonElement);
    const input = document.querySelector('[data-mobile-group-name-input]') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'New Name');

    const saveBtn = document.querySelector('[data-mobile-group-save]') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    await user.click(saveBtn);

    await waitFor(() => expect(mockUpdateMetadata).toHaveBeenCalledTimes(1));
    expect(mockUpdateMetadata).toHaveBeenCalledWith('dm-1', { name: 'New Name' });
    // Name-only path — upload helpers must NOT fire.
    expect(mockStartUpload).not.toHaveBeenCalled();
  });

  it('icon edit: Save first uploads the staged Blob, then PATCHes with { icon: filename }', async () => {
    const user = userEvent.setup();
    const dm = makeGroupDm();
    setStoreState({ dmChannel: dm, authUser: makeUser({ id: 'user-self' }) });

    renderScreen();
    await user.click(document.querySelector('[data-mobile-group-edit]') as HTMLButtonElement);

    // Run the cropper round-trip; the mocked cropper synchronously hands a
    // Blob back to the component, transitioning iconState → 'staged'.
    await stageIcon(user);

    const saveBtn = document.querySelector('[data-mobile-group-save]') as HTMLButtonElement;
    await waitFor(() => expect(saveBtn.disabled).toBe(false));
    await user.click(saveBtn);

    await waitFor(() => expect(mockStartUpload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockUpdateMetadata).toHaveBeenCalledTimes(1));
    expect(mockUpdateMetadata).toHaveBeenCalledWith('dm-1', { icon: 'icon-123.webp' });
  });
});

describe('MobileGroupDmInfo — cancel', () => {
  it('Cancel after staging an icon discards state — no /api/uploads call fires, name reverts', async () => {
    const user = userEvent.setup();
    const dm = makeGroupDm({ name: 'Stable' });
    setStoreState({ dmChannel: dm, authUser: makeUser({ id: 'user-self' }) });

    renderScreen();
    await user.click(document.querySelector('[data-mobile-group-edit]') as HTMLButtonElement);

    // Dirty the name AND stage an icon, then Cancel.
    const input = document.querySelector('[data-mobile-group-name-input]') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'Dirty Name');
    await stageIcon(user);

    const cancelBtn = document.querySelector('[data-mobile-group-save-cancel]') as HTMLButtonElement;
    await user.click(cancelBtn);

    // Edit bar unmounts; resting heading reappears with original name.
    await waitFor(() => expect(document.querySelector('[data-mobile-group-edit-bar]')).toBeNull());
    const heading = document.querySelector('[data-mobile-group-name]');
    expect(heading?.textContent).toBe('Stable');

    // No upload + no PATCH must have fired.
    expect(mockStartUpload).not.toHaveBeenCalled();
    expect(mockUpdateMetadata).not.toHaveBeenCalled();
    const uploadCalls = fetchSpy.mock.calls.filter(([url]: [string]) =>
      typeof url === 'string' && url.includes('/api/uploads'),
    );
    expect(uploadCalls.length).toBe(0);
  });
});

describe('MobileGroupDmInfo — member row interactions', () => {
  it('tapping View Profile on a row pushes the mobile user-profile screen via openUserProfile', async () => {
    const user = userEvent.setup();
    const dm = makeGroupDm();
    setStoreState({ dmChannel: dm, authUser: makeUser({ id: 'user-self' }) });

    renderScreen();

    // Right-click (contextMenu event) on the non-owner row "Alice" to open
    // the row's menu. The kebab is rendered but contextMenu is the most
    // reliable mobile-equivalent trigger in jsdom (no long-press in DOM).
    const rows = document.querySelectorAll('[data-dm-member-row]');
    // Owner is rendered first, then sorted online members. Alice should be
    // the second row (online, non-owner, alphabetical).
    const aliceRow = Array.from(rows).find((r) => (r as HTMLElement).dataset.userId === 'user-2');
    expect(aliceRow).toBeTruthy();

    fireEvent.contextMenu(aliceRow!, { clientX: 100, clientY: 100 });

    const profileBtn = await screen.findByText('View Profile');
    await user.click(profileBtn);

    // The DmMemberRow itself routes the "profile" action by calling
    // `useUIStore.getState().openUserProfile(...)`. On mobile that pushes a
    // `user-profile` entry onto the mobile stack (see uiStore.openUserProfile).
    await waitFor(() => {
      const stack = useUIStore.getState().mobileStack;
      const top = stack[stack.length - 1];
      expect(top?.screen).toBe('user-profile');
      expect(top?.params?.userId).toBe('user-2');
    });
  });

  it('long-press / context menu on a row opens the action menu', async () => {
    const dm = makeGroupDm();
    setStoreState({ dmChannel: dm, authUser: makeUser({ id: 'user-self' }) });

    renderScreen();

    const rows = document.querySelectorAll('[data-dm-member-row]');
    const aliceRow = Array.from(rows).find((r) => (r as HTMLElement).dataset.userId === 'user-2');
    expect(aliceRow).toBeTruthy();

    // Synthetic contextmenu event — DmMemberRow's `onContextMenu` handler
    // calls openContextMenu(). After firing, the portal-rendered menu should
    // contain at least the "View Profile" entry.
    fireEvent.contextMenu(aliceRow!, { clientX: 100, clientY: 100 });

    const profile = await screen.findByText('View Profile');
    expect(profile).not.toBeNull();
    // Owner-caller + non-self → Transfer + Remove visible too.
    expect(screen.queryByText('Transfer Ownership')).not.toBeNull();
    expect(screen.queryByText('Remove from Group')).not.toBeNull();
  });
});
