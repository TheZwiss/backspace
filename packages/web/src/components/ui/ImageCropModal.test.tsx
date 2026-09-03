import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ImageCropModal } from './ImageCropModal';

// These cases mount the real react-easy-crop widget rather than a stub. jsdom
// gives every box a zero size, so the crop geometry is meaningless here. What
// is being pinned is that the widget mounts, receives the props this modal
// passes it, and still injects its own stylesheet. A version bump that dropped
// any of those would otherwise render an invisible cropper with no error.

function renderModal(props: Partial<React.ComponentProps<typeof ImageCropModal>> = {}) {
  const onClose = vi.fn();
  const onCropComplete = vi.fn();
  const view = render(
    <ImageCropModal
      isOpen
      imageSrc="blob:test-image"
      onClose={onClose}
      onCropComplete={onCropComplete}
      {...props}
    />,
  );
  return { ...view, onClose, onCropComplete };
}

function injectedStyles(): string {
  return Array.from(document.head.querySelectorAll('style'))
    .map((el) => el.textContent ?? '')
    .join('\n');
}

describe('ImageCropModal', () => {
  it('renders nothing while closed', () => {
    const { container } = render(
      <ImageCropModal
        isOpen={false}
        imageSrc="blob:test-image"
        onClose={vi.fn()}
        onCropComplete={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe('');
    expect(injectedStyles()).not.toContain('.reactEasyCrop_Container');
  });

  it('mounts the cropper with the image and injects its stylesheet', () => {
    const { container } = renderModal();

    expect(container.querySelector('.reactEasyCrop_Container')).not.toBeNull();

    const image = container.querySelector('img.reactEasyCrop_Image');
    expect(image).not.toBeNull();
    expect(image!.getAttribute('src')).toBe('blob:test-image');

    // The widget ships no stylesheet import; it appends one to <head> itself.
    expect(injectedStyles()).toContain('.reactEasyCrop_Container');
  });

  it('passes cropShape through to the crop area', () => {
    const { container } = renderModal();
    expect(container.querySelector('.reactEasyCrop_CropAreaRound')).not.toBeNull();
  });

  it('renders a square crop area when cropShape is rect', () => {
    const { container } = renderModal({ cropShape: 'rect' });
    expect(container.querySelector('.reactEasyCrop_CropArea')).not.toBeNull();
    expect(container.querySelector('.reactEasyCrop_CropAreaRound')).toBeNull();
  });

  it('keeps the grid off', () => {
    const { container } = renderModal();
    expect(container.querySelector('.reactEasyCrop_CropAreaGrid')).toBeNull();
  });

  it('uses the given title', () => {
    renderModal({ title: 'Crop Banner' });
    expect(screen.getByRole('heading', { name: 'Crop Banner' })).toBeInTheDocument();
  });

  it('closes on Cancel and on Escape', () => {
    const { onClose } = renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('drives zoom from the slider', () => {
    const { container } = renderModal();
    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;

    expect(slider.value).toBe('1');
    fireEvent.change(slider, { target: { value: '2.5' } });
    expect(slider.value).toBe('2.5');
  });
});
