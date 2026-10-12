import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StickerPicker, filterStickers } from './StickerPicker';
import { StickerMessage } from './StickerMessage';
import { api, HttpError } from '../../api/client';
import { uploadSticker } from './stickerUpload';
import { MAX_PERSONAL_STICKERS } from '@backspace/shared/src/stickers';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { PickerEscapeScope } from './pickerEscape';

vi.mock('../../api/client', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/client')>(),
  api: { stickers: { list: vi.fn(), remove: vi.fn(), collect: vi.fn(), rename: vi.fn() } },
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

  it('filters by name, ignoring case, and says so when nothing matches', async () => {
    const cat = { id: 'b'.repeat(64), name: 'CoolCat', token: `sticker:https://chat.test/api/stickers/assets/${'b'.repeat(64)}.webp` };
    vi.mocked(api.stickers.list).mockResolvedValue([sticker, cat]);
    render(<StickerPicker onSelect={vi.fn()} />);
    await screen.findByRole('button', { name: 'Happy' });

    const search = screen.getByRole('searchbox', { name: 'Search stickers' });
    fireEvent.change(search, { target: { value: '  cool ' } });
    expect(screen.getByRole('button', { name: 'CoolCat' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Happy' })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'nothing' } });
    expect(screen.getByRole('status')).toHaveTextContent('No stickers found');
    expect(screen.queryByRole('button', { name: 'CoolCat' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(search).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Happy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'CoolCat' })).toBeInTheDocument();
  });

  it('offers no search on an empty collection', async () => {
    vi.mocked(api.stickers.list).mockResolvedValue([]);
    render(<StickerPicker onSelect={vi.fn()} />);
    await screen.findByText('Your sticker collection starts here');
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
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

  it('leaves the upload form on Escape and gives focus back to the upload button', async () => {
    const onClose = vi.fn();
    render(<PickerEscapeScope onClose={onClose}><StickerPicker onSelect={vi.fn()} /></PickerEscapeScope>);
    await screen.findByRole('button', { name: 'Happy' });
    fireEvent.click(screen.getByRole('button', { name: 'Upload image' }));
    expect(screen.getByLabelText('Choose image', { selector: 'input' })).toBeInTheDocument();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByLabelText('Choose image', { selector: 'input' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload image' })).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps a form open on Escape while it is sending', async () => {
    const onClose = vi.fn();
    let finish: (value: typeof sticker) => void = () => undefined;
    vi.mocked(api.stickers.rename).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<PickerEscapeScope onClose={onClose}><StickerPicker onSelect={vi.fn()} /></PickerEscapeScope>);
    await screen.findByRole('button', { name: 'Happy' });
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename Happy' }));
    fireEvent.change(screen.getByLabelText('Sticker name'), { target: { value: 'Glad' } });
    fireEvent.submit(screen.getByRole('form'));

    fireEvent.keyDown(screen.getByLabelText('Sticker name'), { key: 'Escape' });
    expect(screen.getByRole('form')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    finish({ ...sticker, name: 'Glad' });
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Rename Glad' })).toHaveFocus();
  });

  it('checks the name before sending and keeps a refusal visible', async () => {
    render(<StickerPicker onSelect={vi.fn()} />);
    await screen.findByRole('button', { name: 'Happy' });
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename Happy' }));
    const input = screen.getByLabelText('Sticker name');

    fireEvent.change(input, { target: { value: 'two\u0007bell' } });
    fireEvent.submit(screen.getByRole('form'));
    expect(screen.getByRole('alert')).toHaveTextContent('Sticker names can be 1 to 100 characters on one line');
    expect(api.stickers.rename).not.toHaveBeenCalled();

    vi.mocked(api.stickers.rename).mockRejectedValueOnce(new HttpError(404, 'Sticker not found', undefined, 'sticker_not_found'));
    fireEvent.change(input, { target: { value: 'Gone' } });
    fireEvent.submit(screen.getByRole('form'));
    expect(await screen.findByRole('alert')).toHaveTextContent('That sticker no longer exists.');
    expect(screen.getByRole('form', { name: 'Rename sticker' })).toBeInTheDocument();

    // An unchanged name closes the form without a request.
    vi.mocked(api.stickers.rename).mockClear();
    fireEvent.change(input, { target: { value: ' Happy ' } });
    fireEvent.submit(screen.getByRole('form'));
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(api.stickers.rename).not.toHaveBeenCalled();
  });
});

describe('filterStickers', () => {
  it('matches a trimmed query anywhere in the name, ignoring case', () => {
    expect(filterStickers([sticker], '   ')).toEqual([sticker]);
    expect(filterStickers([sticker], 'APP')).toEqual([sticker]);
    expect(filterStickers([sticker], 'sad')).toEqual([]);
  });
});
