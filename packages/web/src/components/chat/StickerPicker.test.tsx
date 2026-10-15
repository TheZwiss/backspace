import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StickerPicker } from './StickerPicker';
import { StickerMessage } from './StickerMessage';
import { api } from '../../api/client';
import { uploadSticker } from './stickerUpload';
import { MAX_PERSONAL_STICKERS, type StickerPackDetail } from '@backspace/shared/src/stickers';

import { useContextMenuStore } from '../../stores/contextMenuStore';
import { PickerEscapeScope } from './pickerEscape';

vi.mock('../../api/client', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/client')>(),
  api: {
    stickers: { list: vi.fn(), remove: vi.fn(), collect: vi.fn(), rename: vi.fn() },
    stickerStore: { myPacks: vi.fn().mockResolvedValue([]), getPack: vi.fn().mockResolvedValue(null) },
    instance: { info: vi.fn().mockResolvedValue({}) },
  },
}));
vi.mock('./stickerUpload', () => ({ uploadSticker: vi.fn() }));
vi.mock('../../stores/authStore', () => ({ useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: { id: 'alice' } }) }));
const preview = vi.hoisted(() => vi.fn());
vi.mock('../../stores/uiStore', () => ({ useUIStore: (selector: (s: unknown) => unknown) => selector({ openImagePreview: preview }) }));
const sticker = { id: 'a'.repeat(64), name: 'Happy', token: `sticker:https://chat.test/api/stickers/assets/${'a'.repeat(64)}.webp` };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:sticker-preview');
    static revokeObjectURL = vi.fn();
  });
  vi.mocked(api.stickers.list).mockResolvedValue([sticker]);
  vi.mocked(api.stickers.remove).mockResolvedValue({ success: true });
  vi.mocked(api.stickers.collect).mockResolvedValue(sticker);
  vi.mocked(api.stickers.rename).mockImplementation(async (id, name) => ({ ...sticker, id, name }));
  vi.mocked(uploadSticker).mockResolvedValue(sticker);
});

afterEach(() => vi.unstubAllGlobals());

function chooseImage() {
  fireEvent.click(screen.getByRole('button', { name: 'Upload image' }));
  fireEvent.change(screen.getByLabelText('Choose image', { selector: 'input' }), { target: { files: [new File(['png'], 'x.png', { type: 'image/png' })] } });
  fireEvent.load(screen.getByAltText('Preview sticker'));
  fireEvent.click(screen.getByRole('button', { name: 'Add to my stickers' }));
}

describe('sticker controls', () => {
  it('selects a sticker and removes only after successful API confirmation', async () => {
    const onSelect = vi.fn();
    render(<StickerPicker onSelect={onSelect} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Happy' }));
    expect(onSelect).toHaveBeenCalledWith(sticker.token);
    expect(screen.queryByRole('button', { name: 'Remove Happy' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Happy' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Happy' })).not.toBeInTheDocument());
    expect(api.stickers.remove).toHaveBeenCalledWith(sticker.id);
  });

  it('shows upload errors rather than adding an unsuccessful item', async () => {
    vi.mocked(api.stickers.list).mockResolvedValue([]);
    vi.mocked(uploadSticker).mockRejectedValueOnce(new Error('Invalid image'));
    render(<StickerPicker onSelect={vi.fn()} />);
    await screen.findByText('Your sticker collection starts here');
    chooseImage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid image');
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:sticker-preview');
    expect(screen.getByRole('textbox', { name: 'Sticker name' })).toHaveValue('x');
  });

  it('deduplicates successful uploads in the current list', async () => {
    render(<StickerPicker onSelect={vi.fn()} />);
    await screen.findByRole('button', { name: 'Happy' });
    chooseImage();
    await waitFor(() => expect(uploadSticker).toHaveBeenCalledOnce());
    await screen.findByRole('button', { name: 'Happy' });
    expect(screen.getAllByRole('button', { name: 'Happy' })).toHaveLength(1);
  });

  it('supports uploading multiple stickers and adds them all to the collection', async () => {
    const sticker2 = { id: 'b'.repeat(64), name: 'Cool', token: `sticker:https://chat.test/api/stickers/assets/${'b'.repeat(64)}.webp` };
    vi.mocked(api.stickers.list).mockResolvedValue([]);
    vi.mocked(uploadSticker).mockImplementation(async (file, name) => {
      return name === 'Cool' ? sticker2 : sticker;
    });

    render(<StickerPicker onSelect={vi.fn()} />);
    await screen.findByText('Your sticker collection starts here');

    fireEvent.click(screen.getByRole('button', { name: 'Upload image' }));
    const f1 = new File(['1'], 'Happy.png', { type: 'image/png' });
    const f2 = new File(['2'], 'Cool.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Choose image', { selector: 'input' }), { target: { files: [f1, f2] } });

    const previews = screen.getAllByAltText('Preview sticker');
    expect(previews).toHaveLength(2);
    previews.forEach(p => fireEvent.load(p));

    fireEvent.click(screen.getByRole('button', { name: 'Add to my stickers' }));

    await waitFor(() => expect(uploadSticker).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Happy' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Cool' })).toBeInTheDocument();
    // Newest first, as the server lists the collection after a reload.
    const tiles = screen.getAllByRole('button').filter(button => ['Happy', 'Cool'].includes(button.getAttribute('aria-label') ?? ''));
    expect(tiles.map(tile => tile.getAttribute('aria-label'))).toEqual(['Cool', 'Happy']);
  });

  it('turns uploading off once the collection is full', async () => {
    vi.mocked(api.stickers.list).mockResolvedValue(Array.from({ length: MAX_PERSONAL_STICKERS }, (_, index) => ({
      ...sticker, id: index.toString(16).padStart(64, '0'), name: `Sticker ${index}`,
    })));
    render(<StickerPicker onSelect={vi.fn()} />);
    expect(await screen.findByText('Your collection is full. Remove a sticker to add another.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload image' })).toBeDisabled();
  });

  it('previews the full image without a permanent collection button', async () => {
    render(<StickerMessage token={sticker.token} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview sticker' }));
    expect(preview).toHaveBeenCalledWith(sticker.token.slice('sticker:'.length));
    expect(screen.queryByRole('button', { name: 'Add to my stickers' })).not.toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute('data-sticker-source', sticker.token);
  });

  it('filters stickers by custom name via search input within the picker panel', async () => {
    const sticker2 = { id: 'b'.repeat(64), name: 'CoolCat', token: 'sticker:coolcat' };
    vi.mocked(api.stickers.list).mockResolvedValue([sticker, sticker2]);
    render(<StickerPicker onSelect={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Happy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'CoolCat' })).toBeInTheDocument();

    const searchInput = screen.getByPlaceholderText('Search stickers');
    fireEvent.change(searchInput, { target: { value: 'Cool' } });

    expect(screen.getByRole('button', { name: 'CoolCat' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Happy' })).not.toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: 'NonExistent' } });
    expect(screen.getByText('No stickers found')).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Happy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'CoolCat' })).toBeInTheDocument();
  });

  it('renames from Manage mode in place of the grid and returns focus to the tile', async () => {
    render(<StickerPicker onSelect={vi.fn()} />);
    await screen.findByRole('button', { name: 'Happy' });
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    expect(screen.getByText(/Rename or remove stickers/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Rename Happy' }));

    const form = screen.getByRole('form', { name: 'Rename sticker' });
    const input = screen.getByLabelText('Sticker name');
    expect(input).toHaveValue('Happy');
    expect(input).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Remove Happy' })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: '  Super Happy ' } });
    fireEvent.submit(form);
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
    expect(api.stickers.rename).toHaveBeenCalledWith(sticker.id, 'Super Happy');
    expect(screen.getByRole('button', { name: 'Rename Super Happy' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Super Happy' })).toBeInTheDocument();
  });

  it('leaves the form unchanged on Escape or Cancel, and offers no right-click menu on a tile', async () => {
    const onClose = vi.fn();
    render(<PickerEscapeScope onClose={onClose}><StickerPicker onSelect={vi.fn()} /></PickerEscapeScope>);
    const tile = await screen.findByRole('button', { name: 'Happy' });
    fireEvent.contextMenu(tile);
    expect(useContextMenuStore.getState().menu).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));

    fireEvent.click(screen.getByRole('button', { name: 'Rename Happy' }));
    fireEvent.keyDown(screen.getByLabelText('Sticker name'), { key: 'Escape' });
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename Happy' })).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Rename Happy' }));
    fireEvent.click(screen.getByText('Cancel', { selector: 'button' }));
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(api.stickers.rename).not.toHaveBeenCalled();
  });

  it('renders compressed preview URL for sticker tiles', async () => {
    render(<StickerPicker onSelect={vi.fn()} />);
    const img = await screen.findByRole('img', { name: 'Happy' });
    expect(img).toHaveAttribute('src', `https://chat.test/api/stickers/assets/${'a'.repeat(64)}.webp?preview=1`);
  });

  it('renders bottom tab bar with shrink-0 and ring-inset on pack tabs', async () => {
    const pack: StickerPackDetail = {
      id: 'pack-1',
      name: 'Cute Cats',
      items: [{ id: 'item-1', name: 'Cat', token: sticker.token, packId: 'pack-1', versionId: 'v1', assetId: sticker.id, sortOrder: 0, status: 'active', createdAt: 1 }],
      creatorId: 'alice',
      creatorName: 'Alice',
      coverAssetId: sticker.id,
      coverUrl: null,
      originType: 'source',
      sourceInstance: null,
      sourcePackId: null,
      currentVersion: 1,
      status: 'approved',
      itemCount: 1,
      createdAt: 1,
      updatedAt: 1,
      description: null,
      reviewNotes: null,
      reviewedBy: null,
      reviewedAt: null,
    };
    vi.mocked(api.stickerStore.myPacks).mockResolvedValue([pack]);
    render(<StickerPicker onSelect={vi.fn()} />);
    const tab = await screen.findByRole('button', { name: 'Cute Cats' });
    expect(tab).toHaveClass('shrink-0');
    fireEvent.click(tab);
    expect(tab).toHaveClass('ring-inset');
  });

  it('hides management, upload, and store controls when manageable is false, while still allowing selection', async () => {
    const onSelect = vi.fn();
    render(<StickerPicker onSelect={onSelect} manageable={false} />);

    // Sticker is visible and selectable
    const stickerBtn = await screen.findByRole('button', { name: 'Happy' });
    expect(stickerBtn).toBeInTheDocument();
    fireEvent.click(stickerBtn);
    expect(onSelect).toHaveBeenCalledWith(sticker.token);

    // Management buttons are hidden
    expect(screen.queryByRole('button', { name: /manage/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /upload/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /store/i })).not.toBeInTheDocument();
  });
});
