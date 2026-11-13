import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NudgePreferencesSection } from './NudgePreferencesSection';
import { useNudgePreferences } from '../../../stores/nudgePreferences';
const initial = useNudgePreferences.getState();
afterEach(() => { cleanup(); useNudgePreferences.setState(initial); });
describe('nudge settings', () => {
  it('saves the disabled scope and hides irrelevant controls', () => {
    render(<NudgePreferencesSection />);
    fireEvent.change(screen.getByLabelText('Where to receive'), { target: { value: 'off' } });
    expect(useNudgePreferences.getState().scope).toBe('off');
    expect(screen.queryByLabelText('How to display')).toBeNull();
  });
  it('offers a fallback and manual monitor selection for games', () => {
    render(<NudgePreferencesSection />);
    fireEvent.change(screen.getByLabelText('While gaming'), { target: { value: 'other-displays' } });
    fireEvent.change(screen.getByLabelText('Where the game is'), { target: { value: 'primary' } });
    fireEvent.change(screen.getByLabelText('When no monitor is free or the game monitor is unknown'), { target: { value: 'off' } });
    expect(useNudgePreferences.getState()).toMatchObject({ gameAction: 'other-displays', gameMonitor: 'primary', gameFallback: 'off' });
  });
});
