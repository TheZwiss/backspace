import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/soundboard', () => ({ previewSoundboardCut: vi.fn() }));

import { SoundTrimmer } from './SoundTrimmer';
import { previewSoundboardCut } from '../../utils/soundboard';

/** The slice of AudioBuffer the trimmer reads. */
function fakeBuffer(seconds: number): AudioBuffer {
  const rate = 100;
  const data = new Float32Array(Math.round(seconds * rate)).fill(0.2);
  return {
    duration: seconds, sampleRate: rate, numberOfChannels: 1, length: data.length,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

function setup(seconds: number, props: Partial<React.ComponentProps<typeof SoundTrimmer>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<SoundTrimmer isOpen buffer={fakeBuffer(seconds)} fileName="boom.wav" onConfirm={onConfirm} onCancel={onCancel} {...props} />);
  return { onConfirm, onCancel };
}

const length = () => document.querySelector('[data-trimmer-length]')!.textContent;

describe('SoundTrimmer', () => {
  beforeEach(() => { vi.mocked(previewSoundboardCut).mockReset(); });

  it('starts a long file at the first 5 seconds and says the file is too long', () => {
    setup(12);
    expect(length()).toBe('5 s');
    expect(screen.getByText(/boom\.wav lasts 12 s\. Choose up to 5 s to keep\./)).toBeTruthy();
  });

  it('keeps a short file whole', () => {
    setup(3);
    expect(length()).toBe('3 s');
  });

  it('the end handle cannot stretch the cut past 5 seconds', () => {
    setup(12);
    const end = screen.getByRole('slider', { name: 'Cut end' });
    for (let i = 0; i < 3; i++) fireEvent.keyDown(end, { key: 'ArrowRight', shiftKey: true });
    expect(length()).toBe('5 s');
  });

  it('the start handle can shorten the cut', () => {
    setup(12);
    const start = screen.getByRole('slider', { name: 'Cut start' });
    for (let i = 0; i < 10; i++) fireEvent.keyDown(start, { key: 'ArrowRight', shiftKey: true });
    expect(length()).toBe('4 s');
  });

  it('arrow keys on the window slide it without changing the length', () => {
    setup(12);
    const windowHandle = screen.getByRole('slider', { name: 'Selected part' });
    for (let i = 0; i < 5; i++) fireEvent.keyDown(windowHandle, { key: 'ArrowRight', shiftKey: true });
    expect(length()).toBe('5 s');
    expect(windowHandle.getAttribute('aria-valuenow')).toBe('0.5');
  });

  it('confirms the chosen cut with the fade setting', () => {
    const { onConfirm } = setup(12);
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Cut start' }), { key: 'ArrowRight', shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Use this cut' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const cut = onConfirm.mock.calls[0]![0] as { start: number; end: number; fade: boolean };
    expect(cut.start).toBeCloseTo(0.1);
    expect(cut.end).toBe(5);
    expect(cut.fade).toBe(true);
  });

  it('reset returns to the first 5 seconds', () => {
    setup(12);
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Selected part' }), { key: 'ArrowRight', shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByRole('slider', { name: 'Selected part' }).getAttribute('aria-valuenow')).toBe('0');
  });

  it('cancel does not confirm', () => {
    const { onConfirm, onCancel } = setup(12);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('previews the selected cut locally and stops on request', async () => {
    const stop = vi.fn();
    vi.mocked(previewSoundboardCut).mockResolvedValue({ stop, position: () => 1, ended: new Promise(() => {}) });
    setup(12);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(previewSoundboardCut).toHaveBeenCalledWith(expect.anything(), { start: 0, end: 5, fade: true });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(stop).toHaveBeenCalled();
  });
});
