import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VoiceQualitySetting } from './VoiceQualitySetting';

describe('VoiceQualitySetting', () => {
  it('offers the three presets and marks the stored one', () => {
    render(<VoiceQualitySetting value={128} canEdit onSave={vi.fn(async () => {})} />);
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(['64', '128', '256']);
    expect(radios.map((r) => r.checked)).toEqual([false, true, false]);
  });

  it('shows the 128 kbps default for a channel that has no stored value', () => {
    render(<VoiceQualitySetting value={undefined} canEdit onSave={vi.fn(async () => {})} />);
    expect((screen.getAllByRole('radio') as HTMLInputElement[]).map((r) => r.checked)).toEqual([false, true, false]);
  });

  it('saves the picked preset', async () => {
    const onSave = vi.fn(async () => {});
    render(<VoiceQualitySetting value={64} canEdit onSave={onSave} />);
    fireEvent.click(screen.getAllByRole('radio')[2]);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(256));
  });

  it('does not save the preset that is already stored', () => {
    const onSave = vi.fn(async () => {});
    render(<VoiceQualitySetting value={64} canEdit onSave={onSave} />);
    fireEvent.click(screen.getAllByRole('radio')[0]);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('goes back to the stored value when the save fails', async () => {
    const onSave = vi.fn(async () => { throw new Error('nope'); });
    render(<VoiceQualitySetting value={64} canEdit onSave={onSave} />);
    fireEvent.click(screen.getAllByRole('radio')[1]);
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    await waitFor(() => expect((screen.getAllByRole('radio') as HTMLInputElement[]).map((r) => r.checked)).toEqual([true, false, false]));
  });

  it('is read-only without the permission', () => {
    const onSave = vi.fn(async () => {});
    render(<VoiceQualitySetting value={128} canEdit={false} onSave={onSave} />);
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.every((r) => r.disabled)).toBe(true);
    fireEvent.click(radios[2]);
    expect(onSave).not.toHaveBeenCalled();
  });
});
