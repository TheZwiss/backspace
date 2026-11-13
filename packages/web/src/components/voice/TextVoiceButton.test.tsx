import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const { voice } = vi.hoisted(() => ({ voice: { textVoiceEnabled: false } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../stores/voiceStore', () => ({ useVoiceStore: (selector: (state: typeof voice) => unknown) => selector(voice) }));
vi.mock('../../platform/textVoice', () => ({ supportsLocalTextVoice: () => true, getLocalTextVoiceProvider: () => ({}) }));
vi.mock('../../utils/textVoice', () => ({ canUseTextVoice: vi.fn(), speakText: vi.fn(), stopTextVoice: vi.fn() }));
vi.mock('../../utils/dictation', () => ({ cancelDictation: vi.fn() }));
vi.mock('./DictationControls', () => ({ DictationMicButton: () => null, canRecordDictation: () => true, useDictationModels: () => true }));
vi.mock('../ui/Modal', () => ({ Modal: ({ isOpen }: { isOpen: boolean }) => isOpen ? <div role="dialog" /> : null }));
import { TextVoiceButton } from './TextVoice';

it.each([false, true])('renders the real toolbar button with square rounded corners when enabled=%s', (enabled) => {
  voice.textVoiceEnabled = enabled;
  render(<TextVoiceButton variant="toolbar" className="flex-1 h-[34px] bg-surface-base" />);
  const button = screen.getByRole('button', { name: 'textVoice.title' });
  expect(button).toHaveClass('rounded-[4px]', 'flex-1', 'h-[34px]');
  expect(button).not.toHaveClass('rounded-full');
  fireEvent.click(button);
  expect(screen.getByRole('dialog')).toBeTruthy();
});
it('retains the round default button in existing call controls', () => {
  voice.textVoiceEnabled = false;
  render(<TextVoiceButton />);
  const button = screen.getByRole('button', { name: 'textVoice.title' });
  expect(button).toHaveClass('rounded-full', 'w-10', 'h-10');
  expect(button).not.toHaveClass('rounded-[4px]');
});
