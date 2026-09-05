import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useUIStore } from '../../stores/uiStore';
import { isElectron } from '../../platform/platform';
import { ImagePreview } from './ImagePreview';

vi.mock('../../platform/platform', () => ({
  isElectron: vi.fn(),
}));

vi.mock('../../utils/imageActions', () => ({
  saveImage: vi.fn(),
  copyImageToClipboard: vi.fn(),
}));

describe('ImagePreview', () => {
  beforeEach(() => {
    vi.mocked(isElectron).mockReturnValue(false);
    useUIStore.setState({
      activeModal: 'imagePreview',
      imagePreviewUrl: '/test-image.png',
    });
  });

  afterEach(() => {
    useUIStore.getState().closeImagePreview();
  });

  it('covers the complete browser viewport', () => {
    const { container } = render(<ImagePreview />);

    expect(container.firstElementChild).toHaveClass('top-0');
    expect(container.firstElementChild).not.toHaveClass('top-[33px]');
  });

  it('stays below the native window controls in Electron', () => {
    vi.mocked(isElectron).mockReturnValue(true);

    const { container } = render(<ImagePreview />);

    expect(container.firstElementChild).toHaveClass('top-[33px]');
    expect(container.firstElementChild).not.toHaveClass('top-0');
  });
});
