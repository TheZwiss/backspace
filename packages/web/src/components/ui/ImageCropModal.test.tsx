import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
const cropImage = vi.hoisted(() => vi.fn());
vi.mock('../../utils/cropImage', () => ({ cropImage }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-easy-crop', () => ({ default: (props: { onCropComplete: (percent: object, pixels: object) => void }) => <button onClick={() => props.onCropComplete({ x: 10, y: 20, width: 80, height: 60 }, { x: 100, y: 200, width: 800, height: 600 })}>Set crop</button> }));
import { ImageCropModal } from './ImageCropModal';
describe('image crop editor', () => {
  it('returns GIF crop coordinates without flattening the image into a canvas', async () => {
    cropImage.mockClear();
    const selection = vi.fn(); const blob = vi.fn(); const close = vi.fn();
    render(<ImageCropModal isOpen imageSrc="data:image/gif;base64,test" onClose={close} onCropComplete={blob} onCropSelection={selection} />);
    fireEvent.click(screen.getByText('Set crop'));
    fireEvent.click(screen.getByText('common:actions.apply'));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(selection).toHaveBeenCalledWith({ x: 100, y: 200, width: 800, height: 600 }, { x: 10, y: 20, width: 80, height: 60 });
    expect(cropImage).not.toHaveBeenCalled(); expect(blob).not.toHaveBeenCalled();
  });
  it('continues to crop static images through the existing canvas path', async () => {
    const blob = new Blob(['image'], { type: 'image/webp' }); cropImage.mockResolvedValue(blob);
    const complete = vi.fn();
    render(<ImageCropModal isOpen imageSrc="test.png" onClose={vi.fn()} onCropComplete={complete} />);
    fireEvent.click(screen.getByText('Set crop'));
    fireEvent.click(screen.getByText('common:actions.apply'));
    await waitFor(() => expect(complete).toHaveBeenCalledWith(blob));
  });
  it('shows naming content and can hold Apply while the name is invalid', () => {
    render(
      <ImageCropModal
        isOpen
        imageSrc="test.png"
        onClose={vi.fn()}
        onCropComplete={vi.fn()}
        extraContent={<label>Name<input defaultValue="" /></label>}
        error="Name is required"
        applyDisabled
      />,
    );
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Name is required');
    expect(screen.getByText('common:actions.apply')).toBeDisabled();
  });
});
