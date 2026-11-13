import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../api/client';
import { StickerLibraryPanel } from './StickerLibraryPanel';

const image = {
  id: 'item-1',
  packId: 'pack-1',
  versionId: 'version-1',
  assetId: 'a'.repeat(64),
  name: 'Original name',
  token: `sticker:https://chat.test/api/stickers/assets/${'a'.repeat(64)}.webp`,
  sortOrder: 0,
  status: 'active',
  createdAt: 1,
};

const pack = {
  id: 'pack-1',
  name: 'My album',
  description: null,
  scopeType: 'user',
  creatorId: 'alice',
  creatorName: 'Alice',
  currentVersion: 1,
  status: 'active',
  canManage: true,
  canAdd: true,
  itemCount: 1,
  itemLimit: 30,
  items: [image],
  shares: [],
};

vi.mock('../../../api/client', () => ({
  api: {
    stickerLibrary: {
      get: vi.fn(),
      createPrivatePack: vi.fn(),
      renamePrivatePack: vi.fn(),
      deletePrivatePack: vi.fn(),
      addItem: vi.fn(),
      renameItem: vi.fn(),
      removeItem: vi.fn(),
      requestShare: vi.fn(),
      addFavoriteToPack: vi.fn(),
      unfavorite: vi.fn(),
    },
  },
}));
vi.mock('../../../stores/authStore', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ user: { id: 'alice' } }),
}));
vi.mock('../../../hooks/useHomeInstanceInfo', () => ({
  useHomeInstanceInfo: () => ({ maxStickerSizeMb: 5 }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) => values?.name ? `${key}:${values.name}` : key,
  }),
}));
vi.mock('../../ui/ImageCropModal', () => ({
  ImageCropModal: (props: {
    isOpen: boolean;
    extraContent?: ReactNode;
    error?: string;
    applyDisabled?: boolean;
    onCropSelection?: (pixels: object, percentage: object) => Promise<void>;
  }) => props.isOpen ? (
    <div>
      {props.extraContent}
      {props.error && <p role="alert">{props.error}</p>}
      <button
        type="button"
        disabled={props.applyDisabled}
        onClick={() => void props.onCropSelection?.({}, { x: 0, y: 0, width: 100, height: 100 })}
      >
        apply-crop
      </button>
    </div>
  ) : null,
}));
vi.mock('../../ui/ConfirmDialog', () => ({
  ConfirmDialog: (props: { isOpen: boolean; onConfirm: () => void }) => props.isOpen
    ? <button type="button" onClick={props.onConfirm}>confirm-delete</button>
    : null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:sticker');
    static revokeObjectURL = vi.fn();
  });
  vi.mocked(api.stickerLibrary.get).mockResolvedValue({
    privatePacks: [pack],
    spaces: [],
    favorites: [],
  });
  vi.mocked(api.stickerLibrary.addItem).mockResolvedValue(image);
  vi.mocked(api.stickerLibrary.deletePrivatePack).mockResolvedValue({ success: true });
});

describe('StickerLibraryPanel', () => {
  it('asks for a sticker name before uploading the crop', async () => {
    const { container } = render(<StickerLibraryPanel />);
    await screen.findAllByText('My album');
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(fileInput, {
      target: { files: [new File(['image'], 'Cool Cat.png', { type: 'image/png' })] },
    });

    const name = screen.getByLabelText('settings:stickers.itemName');
    expect(name).toHaveValue('Cool Cat');
    fireEvent.change(name, { target: { value: 'Gato favorito' } });
    fireEvent.click(screen.getByRole('button', { name: 'apply-crop' }));

    await waitFor(() => expect(api.stickerLibrary.addItem).toHaveBeenCalledWith(
      'pack-1',
      expect.objectContaining({ name: 'Gato favorito' }),
    ));
  });

  it('deletes a private album after confirmation', async () => {
    vi.mocked(api.stickerLibrary.get)
      .mockResolvedValueOnce({ privatePacks: [pack], spaces: [], favorites: [] })
      .mockResolvedValueOnce({ privatePacks: [], spaces: [], favorites: [] });
    render(<StickerLibraryPanel />);
    await screen.findAllByText('My album');

    fireEvent.click(screen.getByRole('button', { name: 'settings:stickers.deletePack' }));
    fireEvent.click(screen.getByRole('button', { name: 'confirm-delete' }));

    await waitFor(() => expect(api.stickerLibrary.deletePrivatePack).toHaveBeenCalledWith('pack-1'));
    expect(await screen.findByText('settings:stickers.deletePackSuccess')).toBeInTheDocument();
  });
});
