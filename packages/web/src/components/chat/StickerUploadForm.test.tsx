import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MAX_STICKER_BATCH, MAX_STICKER_BYTES } from '@backspace/shared/src/stickers';
import { HttpError } from '../../api/client';
import { StickerUploadForm } from './StickerUploadForm';
import { uploadSticker } from './stickerUpload';

vi.mock('./stickerUpload', () => ({ uploadSticker: vi.fn() }));
const sticker = { id: 'a'.repeat(64), name: 'Happy', token: `sticker:https://chat.test/api/stickers/assets/${'a'.repeat(64)}.webp` };
const png = () => new File(['image'], 'Happy.png', { type: 'image/png' });
const choose = (file = png()) => fireEvent.change(screen.getByLabelText('Choose image', { selector: 'input' }), { target: { files: [file] } });
const confirm = () => screen.getByRole('button', { name: 'Add to my stickers' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:local-preview');
    static revokeObjectURL = vi.fn();
  });
  vi.mocked(uploadSticker).mockResolvedValue(sticker);
});
afterEach(() => vi.unstubAllGlobals());

it('previews locally, edits the name, and only uploads after explicit confirmation', async () => {
  const added = vi.fn();
  render(<StickerUploadForm onAdded={added} onCancel={vi.fn()} capacity={200} />);
  expect(screen.getByRole('button', { name: 'Choose image' })).toHaveFocus();
  expect(confirm()).toBeDisabled();
  const file = png();
  choose(file);
  expect(screen.getByRole('textbox')).toHaveValue('Happy');
  expect(uploadSticker).not.toHaveBeenCalled();
  expect(confirm()).toBeDisabled();
  fireEvent.load(screen.getByAltText('Preview sticker'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  My favorite  ' } });
  fireEvent.click(confirm());
  await waitFor(() => expect(added).toHaveBeenCalledWith([sticker], true));
  expect(uploadSticker).toHaveBeenCalledWith(file, 'My favorite', MAX_STICKER_BYTES);
});

it('cancels without uploading and releases its local preview', () => {
  const cancel = vi.fn();
  const { unmount } = render(<StickerUploadForm onAdded={vi.fn()} onCancel={cancel} capacity={200} />);
  choose();
  fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!);
  expect(cancel).toHaveBeenCalledOnce();
  expect(uploadSticker).not.toHaveBeenCalled();
  unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-preview');
});

it('supports dropping and pasting without forwarding files to the message composer', () => {
  const drop = vi.fn();
  const paste = vi.fn();
  render(<div onDrop={drop} onPaste={paste}><StickerUploadForm onAdded={vi.fn()} onCancel={vi.fn()} capacity={200} /></div>);
  fireEvent.drop(screen.getByRole('button', { name: 'Choose image' }), { dataTransfer: { files: [png()] } });
  expect(screen.getByRole('textbox')).toHaveValue('Happy');
  fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [new File(['gif'], 'Dance.gif', { type: 'image/gif' })] } });
  expect(screen.getByRole('textbox')).toHaveValue('Dance');
  expect(drop).not.toHaveBeenCalled();
  expect(paste).not.toHaveBeenCalled();
  expect(uploadSticker).not.toHaveBeenCalled();
});

it.each([
  ['empty', new File([], 'empty.png', { type: 'image/png' }), 'Choose a non-empty image up to 5 MB.'],
  ['oversize', new File([new Uint8Array(MAX_STICKER_BYTES + 1)], 'huge.png', { type: 'image/png' }), 'Choose a non-empty image up to 5 MB.'],
  ['unsupported', new File(['svg'], 'vector.svg', { type: 'image/svg+xml' }), 'Only PNG, JPEG, WebP and GIF images are supported.'],
])('rejects %s files before upload', (_case, file, error) => {
  render(<StickerUploadForm onAdded={vi.fn()} onCancel={vi.fn()} capacity={200} />);
  choose(file);
  expect(screen.getByRole('alert')).toHaveTextContent(error);
  expect(uploadSticker).not.toHaveBeenCalled();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('supports multi-file drops and batch uploading', async () => {
  const added = vi.fn();
  render(<StickerUploadForm onAdded={added} onCancel={vi.fn()} capacity={200} />);
  const file1 = new File(['1'], 'First.png', { type: 'image/png' });
  const file2 = new File(['2'], 'Second.png', { type: 'image/png' });
  fireEvent.drop(screen.getByRole('button', { name: 'Choose image' }), { dataTransfer: { files: [file1, file2] } });

  const textboxes = screen.getAllByRole('textbox');
  expect(textboxes).toHaveLength(2);
  expect(textboxes[0]).toHaveValue('First');
  expect(textboxes[1]).toHaveValue('Second');
  expect(confirm()).toBeDisabled();

  const previews = screen.getAllByAltText('Preview sticker');
  expect(previews).toHaveLength(2);
  previews.forEach(p => fireEvent.load(p));

  expect(confirm()).toBeEnabled();
  fireEvent.click(confirm());

  await waitFor(() => expect(uploadSticker).toHaveBeenCalledTimes(2));
  expect(uploadSticker).toHaveBeenCalledWith(file1, 'First', MAX_STICKER_BYTES);
  expect(uploadSticker).toHaveBeenCalledWith(file2, 'Second', MAX_STICKER_BYTES);
  await waitFor(() => expect(added).toHaveBeenCalledWith([sticker, sticker], true));
});

it('allows removing an item from the batch before submitting', () => {
  render(<StickerUploadForm onAdded={vi.fn()} onCancel={vi.fn()} capacity={200} />);
  const file1 = new File(['1'], 'First.png', { type: 'image/png' });
  const file2 = new File(['2'], 'Second.png', { type: 'image/png' });
  fireEvent.drop(screen.getByRole('button', { name: 'Choose image' }), { dataTransfer: { files: [file1, file2] } });

  expect(screen.getAllByRole('textbox')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Remove First' }));

  // Removing one leaves 1 item, which transitions to single-item view
  expect(screen.getByRole('textbox')).toHaveValue('Second');
});

it('blocks corrupt previews and blank names', () => {
  render(<StickerUploadForm onAdded={vi.fn()} onCancel={vi.fn()} capacity={200} />);
  choose();
  fireEvent.error(screen.getByAltText('Preview sticker'));
  expect(screen.getByRole('alert')).toHaveTextContent('This image cannot be previewed.');
  expect(confirm()).toBeDisabled();
  choose(new File(['gif'], 'good.gif', { type: 'image/gif' }));
  fireEvent.load(screen.getByAltText('Preview sticker'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
  expect(confirm()).toBeDisabled();
});

it('prevents duplicate submits, shows a real pending state, and retains the preview on failure', async () => {
  let reject!: (error: Error) => void;
  vi.mocked(uploadSticker).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  render(<StickerUploadForm onAdded={vi.fn()} onCancel={vi.fn()} capacity={200} />);
  choose();
  fireEvent.load(screen.getByAltText('Preview sticker'));
  fireEvent.click(confirm());
  expect(screen.getByRole('status')).toHaveTextContent('Adding sticker…');
  expect(screen.getByRole('button', { name: 'Adding sticker…' })).toBeDisabled();
  fireEvent.submit(screen.getByRole('textbox').closest('form')!);
  expect(uploadSticker).toHaveBeenCalledOnce();
  await act(async () => reject(new Error('Storage unavailable')));
  expect(screen.getByRole('alert')).toHaveTextContent('Storage unavailable');
  expect(screen.getByRole('textbox')).toHaveValue('Happy');
  expect(confirm()).toBeEnabled();
});

function dropFiles(names: string[]) {
  const files = names.map(name => new File([name], `${name}.png`, { type: 'image/png' }));
  fireEvent.drop(screen.getByRole('button', { name: 'Choose image' }), { dataTransfer: { files } });
  return files;
}

it('sends a batch one image at a time and keeps only the refused ones', async () => {
  const added = vi.fn();
  const second = { ...sticker, id: 'b'.repeat(64), name: 'Third' };
  let release!: () => void;
  vi.mocked(uploadSticker)
    .mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(sticker); }))
    .mockRejectedValueOnce(new HttpError(400, 'Upload a PNG', undefined, 'sticker_invalid_image', { max: 5 }))
    .mockResolvedValueOnce(second);
  render(<StickerUploadForm onAdded={added} onCancel={vi.fn()} capacity={200} />);
  dropFiles(['First', 'Second', 'Third']);
  screen.getAllByAltText('Preview sticker').forEach(preview => fireEvent.load(preview));
  fireEvent.click(confirm());
  expect(uploadSticker).toHaveBeenCalledOnce();
  expect(screen.getByRole('status')).toHaveTextContent('Adding 1 of 3…');
  await act(async () => release());
  await waitFor(() => expect(added).toHaveBeenCalledWith([sticker, second], false));
  expect(uploadSticker).toHaveBeenCalledTimes(3);
  expect(screen.getByRole('alert')).toHaveTextContent('1 image could not be added. It is still listed below.');
  expect(screen.getByRole('textbox')).toHaveValue('Second');
  expect(confirm()).toBeEnabled();
});

it('stops a batch at a refusal every later image would meet', async () => {
  const added = vi.fn();
  vi.mocked(uploadSticker).mockRejectedValueOnce(new HttpError(429, 'Too many requests', undefined, 'rate_limited'));
  render(<StickerUploadForm onAdded={added} onCancel={vi.fn()} capacity={200} />);
  dropFiles(['First', 'Second']);
  screen.getAllByAltText('Preview sticker').forEach(preview => fireEvent.load(preview));
  fireEvent.click(confirm());
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  expect(uploadSticker).toHaveBeenCalledOnce();
  expect(added).not.toHaveBeenCalled();
  expect(screen.getAllByRole('textbox')).toHaveLength(2);
});

it('refuses more images than one batch or the collection can take', () => {
  const { unmount } = render(<StickerUploadForm onAdded={vi.fn()} onCancel={vi.fn()} capacity={200} />);
  dropFiles(Array.from({ length: MAX_STICKER_BATCH + 1 }, (_, index) => `Image${index}`));
  expect(screen.getByRole('alert')).toHaveTextContent(`Choose up to ${MAX_STICKER_BATCH} images at a time.`);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  unmount();
  render(<StickerUploadForm onAdded={vi.fn()} onCancel={vi.fn()} capacity={2} />);
  dropFiles(['First', 'Second', 'Third']);
  expect(screen.getByRole('alert')).toHaveTextContent('Your collection has room for 2 more stickers.');
});
