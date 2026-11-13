import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NudgeButton } from './NudgeButton';
import { wsSend } from '../../hooks/useWebSocket';

vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn(() => true) }));
vi.mock('../../stores/spaceStore', () => ({ getChannelOrigin: () => '' }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('attention effect menu', () => {
  it('opens without sending and sends only the selected effect with the shared cooldown', () => {
    render(<NudgeButton channelId="123" />);
    fireEvent.click(screen.getByRole('button', { name: 'Nudge' }));
    expect(screen.getAllByRole('menuitem')).toHaveLength(21);
    expect(wsSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: /Jelly/ }));
    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_nudge', dmChannelId: '123', effect: 'jelly' }, '');
    expect(screen.queryByRole('menu')).toBeNull();
    expect((screen.getByRole('button', { name: 'Nudge' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('dismisses with Escape without sending', () => {
    render(<NudgeButton channelId="123" />);
    fireEvent.click(screen.getByRole('button', { name: 'Nudge' }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(wsSend).not.toHaveBeenCalled();
  });
  it('sends a new MSN wink without changing the existing effect entries', () => {
    render(<NudgeButton channelId="123" />);
    fireEvent.click(screen.getByRole('button', { name: 'Nudge' }));
    expect(screen.getByRole('menuitem', { name: /MSN shake/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Knock on screen/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: /Dancing pig/ }));
    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_nudge', dmChannelId: '123', effect: 'msn_dancing_pig' }, '');
  });
  it('sends the original Fart Guy from its own menu entry', () => {
    render(<NudgeButton channelId="123" />);
    fireEvent.click(screen.getByRole('button', { name: 'Nudge' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Fart Guy/ }));
    expect(wsSend).toHaveBeenCalledWith({ type: 'dm_nudge', dmChannelId: '123', effect: 'msn_fart_guy' }, '');
  });
});
