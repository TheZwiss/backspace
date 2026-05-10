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

// Mock ImageCropModal so tests can deterministically drive the
// `onCropComplete(blob)` path. The real `react-easy-crop` widget doesn't fire
// its `onCropComplete` callback reliably under jsdom (no real layout), so the
// production cropper is replaced with a minimal dialog that exposes a
// "Confirm Crop" button which immediately hands a synthetic Blob back to the
// parent — exercising the same staged-icon state transition as production.
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

// Mock global fetch — used to detect *any* upload attempt. The test for
// "Cancel discards" asserts that no /api/uploads call ever happens.
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
// We expose a controllable mock so tests assert call counts.
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

// Mock waitForTransferAttachment to resolve with a deterministic filename.
const mockWaitForTransfer = vi.fn();
vi.mock('../../utils/waitForTransfer', () => ({
  waitForTransferAttachment: (...args: unknown[]) => mockWaitForTransfer(...args),
}));

// Mock cropImage so ImageCropModal's apply step doesn't try to read a real image.
vi.mock('../../utils/cropImage', () => ({
  cropImage: vi.fn().mockResolvedValue(new Blob(['cropped'], { type: 'image/webp' })),
}));

import { GroupDmSettings } from './GroupDmSettings';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useSocialStore } from '../../stores/socialStore';

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
  useUIStore.setState({
    activeModal: 'groupDmSettings',
    modalData: { dmChannelId: opts.dmChannel.id },
    isMobile: false,
  });
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

  useUIStore.setState({
    activeModal: null,
    modalData: {},
    isMobile: false,
    toasts: [],
  });
});

function renderModal() {
  return render(<GroupDmSettings />);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GroupDmSettings — non-owner', () => {
  it('disables the name input, hides Save, and disables icon clicks', () => {
    const dm = makeGroupDm({ ownerId: 'user-2' }); // viewer is NOT owner
    setStoreState({ dmChannel: dm, authUser: makeUser({ id: 'user-self' }) });

    renderModal();

    const input = screen.getByLabelText('Group name') as HTMLInputElement;
    expect(input.disabled).toBe(true);

    // Save button is not rendered for non-owners; only "Close".
    expect(screen.queryByTestId).toBeDefined(); // sanity
    expect(document.querySelector('[data-group-dm-save]')).toBeNull();
    expect(document.querySelector('[data-group-dm-close]')).not.toBeNull();

    // Hero is a disabled button.
    const hero = document.querySelector('[data-group-dm-icon-hero]') as HTMLButtonElement;
    expect(hero.disabled).toBe(true);

    // Leave button is still enabled.
    const leaveBtn = document.querySelector('[data-group-dm-leave]') as HTMLButtonElement;
    expect(leaveBtn).not.toBeNull();
    expect(leaveBtn.disabled).toBe(false);
  });
});

describe('GroupDmSettings — owner overview', () => {
  it('enables the name input, name change marks dirty, Save calls updateMetadata', async () => {
    const user = userEvent.setup();
    const dm = makeGroupDm({ name: 'Old Name' });
    setStoreState({ dmChannel: dm, authUser: makeUser({ id: 'user-self' }) });

    renderModal();

    const input = screen.getByLabelText('Group name') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('Old Name');

    // Save is rendered but disabled when not dirty.
    const saveBtn = document.querySelector('[data-group-dm-save]') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    await user.clear(input);
    await user.type(input, 'New Name');

    expect(saveBtn.disabled).toBe(false);
    await user.click(saveBtn);

    await waitFor(() => expect(mockUpdateMetadata).toHaveBeenCalledTimes(1));
    expect(mockUpdateMetadata).toHaveBeenCalledWith('dm-1', { name: 'New Name' });
    // Upload helpers should NOT fire — name-only edit.
    expect(mockStartUpload).not.toHaveBeenCalled();
  });

  it('no-op save: Save button stays disabled when nothing has changed', () => {
    const dm = makeGroupDm({ name: 'Stable' });
    setStoreState({ dmChannel: dm, authUser: makeUser({ id: 'user-self' }) });
    renderModal();
    const saveBtn = document.querySelector('[data-group-dm-save]') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });
});

describe('GroupDmSettings — icon staging', () => {
  // Helper: drive a crop blob into the staged-icon state by exercising the
  // production pipeline end-to-end:
  //   1. Fire a change event on the hidden file input (simulates file picker).
  //   2. Wait for the (mocked) ImageCropModal dialog to appear once
  //      FileReader.onload resolves and `cropSrc` becomes non-null.
  //   3. Click "Confirm Crop" on the mock — this fires the real
  //      `onCropComplete(blob)` callback synchronously, which causes
  //      GroupDmSettings to transition iconState → 'staged'.
  //   4. Wait for the cropper dialog to disappear (parent setCropSrc(null)).
  // After this helper resolves, the component is in the staged-icon state
  // and Save will exercise the upload + PATCH path.
  async function stageIcon(user: ReturnType<typeof userEvent.setup>) {
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).not.toBeNull();
    const file = new File(['raw'], 'pick.png', { type: 'image/png' });
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });
    // Cropper opens once FileReader.onload resolves cropSrc.
    const confirmBtn = await screen.findByTestId('cropper-mock-confirm');
    await user.click(confirmBtn);
    // After confirm, the parent clears cropSrc → cropper unmounts.
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'cropper-mock' })).toBeNull(),
    );
  }

  it('Cancel discards a staged icon — no upload fires', async () => {
    const user = userEvent.setup();
    const dm = makeGroupDm();
    setStoreState({ dmChannel: dm, authUser: makeUser({ id: 'user-self' }) });
    renderModal();

    // Stage an icon via the file picker → cropper round-trip. The mock
    // guarantees onCropComplete fires synchronously on click — if this throws
    // it's a real test failure (no graceful fallback).
    await stageIcon(user);

    // Sanity: staging marks the form dirty → Save becomes enabled.
    const saveBtn = document.querySelector('[data-group-dm-save]') as HTMLButtonElement;
    await waitFor(() => expect(saveBtn.disabled).toBe(false));

    const cancelBtn = document.querySelector('[data-group-dm-cancel]') as HTMLButtonElement;
    await user.click(cancelBtn);

    // Cancel must close the modal and NOT fire any upload or PATCH.
    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(mockStartUpload).not.toHaveBeenCalled();
    expect(mockUpdateMetadata).not.toHaveBeenCalled();
    // Direct /api/uploads POSTs (legacy paths) also must not have happened.
    const uploadCalls = fetchSpy.mock.calls.filter(([url]: [string]) =>
      typeof url === 'string' && url.includes('/api/uploads'),
    );
    expect(uploadCalls.length).toBe(0);
  });

  it('Save after staging an icon: upload fires, then PATCH fires with the filename', async () => {
    const user = userEvent.setup();
    const dm = makeGroupDm();
    setStoreState({ dmChannel: dm, authUser: makeUser({ id: 'user-self' }) });
    renderModal();

    // Stage an icon via the cropper-mock — this hands a real Blob to the
    // component's handleCropComplete, transitioning iconState to 'staged'.
    await stageIcon(user);

    // Save should now trigger startUpload (the staged-icon code path).
    const saveBtn = document.querySelector('[data-group-dm-save]') as HTMLButtonElement;
    await waitFor(() => expect(saveBtn.disabled).toBe(false));
    await user.click(saveBtn);

    await waitFor(() => expect(mockStartUpload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockUpdateMetadata).toHaveBeenCalledTimes(1));
    expect(mockUpdateMetadata).toHaveBeenCalledWith('dm-1', { icon: 'icon-123.webp' });
  });

  it('Clearing the icon (X button): PATCH body contains icon: null', async () => {
    const user = userEvent.setup();
    const dm = makeGroupDm({ icon: 'existing.webp' });
    setStoreState({ dmChannel: dm, authUser: makeUser({ id: 'user-self' }) });
    renderModal();

    const clearBtn = document.querySelector('[data-group-dm-icon-clear]') as HTMLButtonElement;
    expect(clearBtn).not.toBeNull();
    await user.click(clearBtn);

    const saveBtn = document.querySelector('[data-group-dm-save]') as HTMLButtonElement;
    await waitFor(() => expect(saveBtn.disabled).toBe(false));
    await user.click(saveBtn);

    await waitFor(() => expect(mockUpdateMetadata).toHaveBeenCalledTimes(1));
    expect(mockUpdateMetadata).toHaveBeenCalledWith('dm-1', { icon: null });
    // No upload — clear-icon never stages a blob.
    expect(mockStartUpload).not.toHaveBeenCalled();
  });
});

describe('GroupDmSettings — leave', () => {
  it('confirming Leave calls api.dm.leave', async () => {
    const user = userEvent.setup();
    const dm = makeGroupDm({ ownerId: 'user-2' }); // non-owner can still leave
    setStoreState({ dmChannel: dm, authUser: makeUser({ id: 'user-self' }) });
    renderModal();

    const leaveBtn = document.querySelector('[data-group-dm-leave]') as HTMLButtonElement;
    await user.click(leaveBtn);

    // The ConfirmDialog mounts in the same tree (no portal-mocking needed).
    const confirmBtn = await screen.findByRole('button', { name: /^leave$/i });
    await user.click(confirmBtn);

    await waitFor(() => expect(mockLeave).toHaveBeenCalledWith('dm-1'));
  });
});
