import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StickerPicker } from './StickerPicker';
import { StickerMessage } from './StickerMessage';
import { api } from '../../api/client';
import { uploadSticker } from './stickerUpload';

vi.mock('../../api/client', () => ({ api: { stickers: { list: vi.fn(), remove: vi.fn(), collect: vi.fn() } } }));
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
  });

  it('previews the full image without a permanent collection button', async () => {
    render(<StickerMessage token={sticker.token} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview sticker' }));
    expect(preview).toHaveBeenCalledWith(sticker.token.slice('sticker:'.length));
    expect(screen.queryByRole('button', { name: 'Add to my stickers' })).not.toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute('data-sticker-source', sticker.token);
  });
});
