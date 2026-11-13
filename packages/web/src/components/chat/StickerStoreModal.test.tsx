import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StickerStoreModal } from './StickerStoreModal';
import { api } from '../../api/client';
import type { StickerPackDetail, StickerPackSummary } from '@backspace/shared/src/stickers';

let mockIsAdmin = false;

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      stickerStore: {
        listPacks: vi.fn(),
        getPack: vi.fn(),
        install: vi.fn(),
        uninstall: vi.fn(),
        listCreated: vi.fn(),
        createPack: vi.fn(),
        submitReview: vi.fn(),
        newVersion: vi.fn(),
        deletePack: vi.fn(),
      },
      admin: {
        stickerPacks: {
          listReviews: vi.fn(),
          approve: vi.fn(),
          reject: vi.fn(),
        },
      },
    },
  };
});

vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: { id: 'alice', name: 'Alice', isAdmin: mockIsAdmin } }),
}));

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ isAdmin: mockIsAdmin }),
}));

const mockSummary: StickerPackSummary = {
  id: 'pack-1',
  name: 'Pepe The Frog',
  description: 'Classic Pepe stickers',
  creatorId: 'alice',
  creatorName: 'Alice',
  coverAssetId: 'a'.repeat(64),
  coverUrl: `http://localhost:3000/api/stickers/assets/${'a'.repeat(64)}.webp`,
  originType: 'source',
  sourceInstance: null,
  sourcePackId: null,
  currentVersion: 1,
  status: 'approved',
  itemCount: 2,
  isInstalled: false,
  createdAt: 1000,
  updatedAt: 1000,
};

const mockDetail: StickerPackDetail = {
  ...mockSummary,
  reviewNotes: null,
  reviewedBy: 'admin',
  reviewedAt: 1000,
  items: [
    {
      id: 'item-1',
      packId: 'pack-1',
      versionId: 'ver-1',
      assetId: 'a'.repeat(64),
      name: 'Happy Pepe',
      token: `sticker:http://localhost:3000/api/stickers/assets/${'a'.repeat(64)}.webp`,
      sortOrder: 0,
      status: 'active',
      createdAt: 1000,
    },
  ],
};

describe('StickerStoreModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAdmin = false;
    vi.mocked(api.stickerStore.listPacks).mockResolvedValue([mockSummary]);
    vi.mocked(api.stickerStore.getPack).mockResolvedValue(mockDetail);
    vi.mocked(api.stickerStore.install).mockResolvedValue({ success: true });
    vi.mocked(api.stickerStore.uninstall).mockResolvedValue({ success: true });
    vi.mocked(api.stickerStore.listCreated).mockResolvedValue([mockDetail]);
    vi.mocked(api.admin.stickerPacks.listReviews).mockResolvedValue([]);
    vi.mocked(api.admin.stickerPacks.approve).mockResolvedValue({ success: true });
    vi.mocked(api.admin.stickerPacks.reject).mockResolvedValue({ success: true });
  });

  it('renders store packs and installs a pack', async () => {
    const onPacksChanged = vi.fn();
    render(<StickerStoreModal onClose={vi.fn()} onPacksChanged={onPacksChanged} />);

    expect(await screen.findByText('Pepe The Frog')).toBeInTheDocument();
    expect(screen.getByText('Classic Pepe stickers')).toBeInTheDocument();

    const installButton = screen.getByRole('button', { name: /\+ Add/i });
    fireEvent.click(installButton);

    await waitFor(() => {
      expect(api.stickerStore.install).toHaveBeenCalledWith('pack-1');
      expect(onPacksChanged).toHaveBeenCalled();
    });
  });

  it('opens preview dialog when clicking pack preview', async () => {
    render(<StickerStoreModal onClose={vi.fn()} />);

    const packTitle = await screen.findByText('Pepe The Frog');
    fireEvent.click(packTitle);

    await waitFor(() => {
      expect(api.stickerStore.getPack).toHaveBeenCalledWith('pack-1');
      expect(screen.getByAltText('Happy Pepe')).toBeInTheDocument();
    });
  });

  it('switches to My Packs tab and displays created packs', async () => {
    render(<StickerStoreModal onClose={vi.fn()} />);

    expect(await screen.findByText('Pepe The Frog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Created by Me/i }));

    await waitFor(() => {
      expect(api.stickerStore.listCreated).toHaveBeenCalled();
      expect(screen.getAllByRole('button', { name: /\+ Create Pack|Create Pack/i }).length).toBeGreaterThan(0);
    });
  });

  it('renders with z-[500] and stops mousedown propagation so underlying popovers are not dismissed', async () => {
    const documentMouseDownListener = vi.fn();
    document.addEventListener('mousedown', documentMouseDownListener);

    render(<StickerStoreModal onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: /store/i });
    expect(dialog).toHaveClass('z-[500]');

    // Mousedown on an element inside the dialog
    const searchInput = screen.getByPlaceholderText(/search/i);
    fireEvent.mouseDown(searchInput);

    // Mousedown should not have bubbled to document
    expect(documentMouseDownListener).not.toHaveBeenCalled();

    document.removeEventListener('mousedown', documentMouseDownListener);
  });

  it('stops Escape propagation on dismiss so parent popover remains open', async () => {
    const onClose = vi.fn();
    const documentEscapeListener = vi.fn();
    document.addEventListener('keydown', documentEscapeListener);

    render(<StickerStoreModal onClose={onClose} />);
    await screen.findByText('Pepe The Frog');

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');
    document.dispatchEvent(event);

    expect(stopPropagationSpy).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();

    document.removeEventListener('keydown', documentEscapeListener);
  });

  it('shows review tab for admins and allows approving sticker packs', async () => {
    mockIsAdmin = true;
    const pendingPack: StickerPackSummary = {
      ...mockSummary,
      id: 'pack-pending-1',
      name: 'Cat Memes',
      status: 'pending_review',
      creatorName: 'Charlie',
      sourceInstance: 'cat.example.org',
    };
    vi.mocked(api.admin.stickerPacks.listReviews).mockResolvedValue([pendingPack]);

    render(<StickerStoreModal onClose={vi.fn()} />);

    const reviewsTab = await screen.findByRole('button', { name: /Review/i });
    expect(reviewsTab).toBeInTheDocument();
    fireEvent.click(reviewsTab);

    await waitFor(() => {
      expect(api.admin.stickerPacks.listReviews).toHaveBeenCalled();
      expect(screen.getByText('Cat Memes')).toBeInTheDocument();
      expect(screen.getByText('Charlie')).toBeInTheDocument();
      expect(screen.getByText('cat.example.org')).toBeInTheDocument();
    });

    const approveButton = screen.getByRole('button', { name: /Approve/i });
    fireEvent.click(approveButton);

    await waitFor(() => {
      expect(api.admin.stickerPacks.approve).toHaveBeenCalledWith('pack-pending-1');
    });
  });

  it('allows admins to reject a sticker pack with a reason in the reject modal', async () => {
    mockIsAdmin = true;
    const pendingPack: StickerPackSummary = {
      ...mockSummary,
      id: 'pack-pending-2',
      name: 'Doge Pack',
      status: 'pending_review',
      creatorName: 'Dave',
    };
    vi.mocked(api.admin.stickerPacks.listReviews).mockResolvedValue([pendingPack]);

    render(<StickerStoreModal onClose={vi.fn()} />);

    const reviewsTab = await screen.findByRole('button', { name: /Review/i });
    fireEvent.click(reviewsTab);

    expect(await screen.findByText('Doge Pack')).toBeInTheDocument();

    const rejectButton = screen.getByRole('button', { name: /^Reject$/i });
    fireEvent.click(rejectButton);

    // Rejection modal appears
    const reasonTextarea = await screen.findByPlaceholderText(/inappropriate content/i);
    expect(reasonTextarea).toBeInTheDocument();
    fireEvent.change(reasonTextarea, { target: { value: 'Image resolution too low' } });

    const confirmRejectBtn = screen.getByRole('button', { name: /Confirm Reject/i });
    fireEvent.click(confirmRejectBtn);

    await waitFor(() => {
      expect(api.admin.stickerPacks.reject).toHaveBeenCalledWith('pack-pending-2', 'Image resolution too low');
    });
  });

  it('displays rejection reasons and review progress for created packs', async () => {
    const rejectedPack: StickerPackSummary = {
      ...mockSummary,
      id: 'pack-rejected',
      name: 'Rejected Shiba',
      status: 'rejected',
      reviewNotes: 'Low resolution and duplicate stickers found',
    };
    vi.mocked(api.stickerStore.listCreated).mockResolvedValue([rejectedPack]);

    render(<StickerStoreModal onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Created by Me/i }));

    expect(await screen.findByText('Rejected Shiba')).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(screen.getByText(/Low resolution and duplicate stickers found/)).toBeInTheDocument();
  });

  it('displays creator name and source instance in the pack preview modal', async () => {
    const federatedDetail: StickerPackDetail = {
      ...mockDetail,
      name: 'Federated Animals',
      creatorName: 'Eve Artist',
      sourceInstance: 'art.matrix.social',
    };
    vi.mocked(api.stickerStore.getPack).mockResolvedValue(federatedDetail);

    render(<StickerStoreModal onClose={vi.fn()} />);

    const packCard = await screen.findByText('Pepe The Frog');
    fireEvent.click(packCard);

    await waitFor(() => {
      expect(screen.getByText('Federated Animals')).toBeInTheDocument();
      expect(screen.getByText('Eve Artist')).toBeInTheDocument();
      expect(screen.getByText('art.matrix.social')).toBeInTheDocument();
    });
  });
});
