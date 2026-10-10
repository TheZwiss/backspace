import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TranslationCommand,
  TranslationReply,
  TranslationSettings,
} from '@backspace/shared/translation';
vi.mock('../../stores/authStore', async () => {
  const { create } = await import('zustand');
  return { useAuthStore: create(() => ({ user: { id: 'alice' } })) };
});
const openModal = vi.hoisted(() => vi.fn());
vi.mock('../../stores/uiStore', () => ({
  useUIStore: { getState: () => ({ openModal }) },
}));
import { TRANSLATION_SETTLE_MS, useMessageTranslation } from './useMessageTranslation';
import { acceptTranslationSettings, resetTranslationScope, useTranslationStore } from './translationStore';
import { TranslationText } from './TranslationText';
const settings: TranslationSettings = {
  revision: 1,
  connections: [],
  preferences: {
    defaultConnection: null,
    engine: 'google-free',
    targetLanguage: 'zh-CN',
    automatic: true,
    consent: true,
    showOriginal: false,
  },
};
const command = vi.fn<(input: TranslationCommand) => Promise<TranslationReply>>();
let intersection: (visible: boolean) => void;
function Row({ text = 'Hello', enabled = true }: { text?: string; enabled?: boolean }) {
  const translation = useMessageTranslation({
    identity: 'channel/message',
    text,
    enabled,
  });
  return (
    <>
      <button onClick={translation.translate} disabled={!translation.translate}>
        translate-message
      </button>
      <TranslationText translation={translation}>
        <p>{text}</p>
      </TranslationText>
    </>
  );
}
beforeEach(() => {
  vi.stubGlobal('location', new URL('https://chat.example'));
  command.mockReset().mockResolvedValue({
    ok: true,
    result: { kind: 'translated', text: '你好' },
  });
  openModal.mockReset();
  Object.defineProperty(window, 'backspace', {
    configurable: true,
    value: { translation: { command } },
  });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  });
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        intersection = (visible) => callback([{ isIntersecting: visible }]);
      }
      observe() {}
      disconnect() {}
    },
  );
  resetTranslationScope('https://chat.example\nalice');
  acceptTranslationSettings(settings);
});
afterEach(() => {
  cleanup();
  resetTranslationScope('');
  delete window.backspace;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('visible user-message translation', () => {
  it('waits for visibility, then replaces only the displayed message body', async () => {
    render(<Row />);
    expect(command).not.toHaveBeenCalled();
    act(() => intersection(true));
    await waitFor(() => expect(screen.getByText('你好')).toBeInTheDocument());
    expect(screen.queryByText('Hello')).not.toBeInTheDocument();
    expect(command).toHaveBeenCalledWith({
      action: 'translate',
      accountId: 'alice',
      text: 'Hello',
      revision: 1,
      automatic: true,
    });
  });
  it('does not send system/pending/editing/attachment-only rows when disabled by the caller', () => {
    render(<Row enabled={false} />);
    expect(screen.getByText('translate-message')).toBeDisabled();
    expect(command).not.toHaveBeenCalled();
  });
  it('does not show an old translation after message content changes', async () => {
    const view = render(<Row />);
    fireEvent.click(screen.getByText('translate-message'));
    await waitFor(() => expect(screen.getByText('你好')).toBeInTheDocument());
    view.rerender(<Row text="Edited message" />);
    expect(screen.queryByText('你好')).not.toBeInTheDocument();
    expect(screen.getByText('Edited message')).toBeInTheDocument();
  });
  it('opens settings rather than sending content without consent', () => {
    acceptTranslationSettings({
      ...settings,
      preferences: {
        ...settings.preferences,
        consent: false,
        automatic: false,
      },
    });
    render(<Row />);
    fireEvent.click(screen.getByText('translate-message'));
    expect(openModal).toHaveBeenCalledWith('userSettings', {
      tab: 'translation',
    });
    expect(command).not.toHaveBeenCalled();
  });
  it('does not send hidden-window text, even if the row intersects', () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    render(<Row />);
    act(() => intersection(true));
    expect(command).not.toHaveBeenCalled();
  });
});

describe('message edits and token-saving scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    acceptTranslationSettings({ ...settings, preferences: { ...settings.preferences, automatic: false } });
    command.mockImplementation(async (input) => ({
      ok: true,
      result: { kind: 'translated', text: input.action === 'translate' ? '译：' + input.text : '' },
    }));
  });
  const settle = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRANSLATION_SETTLE_MS);
    });
  };
  const manual = async () => {
    await act(async () => {
      fireEvent.click(screen.getByText('translate-message'));
    });
  };

  it('refreshes manually translated messages after edits even with global auto off', async () => {
    const view = render(<Row />);
    await settle();
    expect(command).not.toHaveBeenCalled();
    await manual();
    act(() => intersection(true));
    expect(screen.getByText('译：Hello')).toBeInTheDocument();
    view.rerender(<Row text="Edited message" />);
    expect(screen.queryByText('译：Hello')).not.toBeInTheDocument();
    await settle();
    expect(screen.getByText('译：Edited message')).toBeInTheDocument();
    expect(command).toHaveBeenCalledTimes(2);
    expect(command.mock.calls[1][0]).toMatchObject({ text: 'Edited message', automatic: false });
  });
  it('does not translate unselected messages or edits with auto off', async () => {
    const view = render(<Row />);
    view.rerender(<Row text="Edited without translating" />);
    await settle();
    expect(command).not.toHaveBeenCalled();
  });
  it('coalesces consecutive edits and reuses an earlier body without a second IPC call', async () => {
    const view = render(<Row />);
    await manual();
    act(() => intersection(true));
    view.rerender(<Row text="First edit" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRANSLATION_SETTLE_MS / 2);
    });
    view.rerender(<Row text="Final edit" />);
    await settle();
    expect(command).toHaveBeenCalledTimes(2);
    expect(command.mock.calls[1][0]).toMatchObject({ text: 'Final edit' });
    view.rerender(<Row />);
    await settle();
    expect(screen.getByText('译：Hello')).toBeInTheDocument();
    expect(command).toHaveBeenCalledTimes(2);
  });
  it('does not retranslate on rerender or unmount/remount with the same body', async () => {
    const view = render(<Row />);
    await manual();
    view.rerender(<Row />);
    view.unmount();
    render(<Row />);
    act(() => intersection(true));
    await settle();
    expect(screen.getByText('译：Hello')).toBeInTheDocument();
    expect(command).toHaveBeenCalledTimes(1);
  });
  it('keeps manual translation intent across unmount and refreshes an offscreen edit on return', async () => {
    const view = render(<Row />);
    await manual();
    view.unmount();
    render(<Row text="Edited offscreen" />);
    await settle();
    expect(command).toHaveBeenCalledTimes(1);
    act(() => intersection(true));
    await settle();
    expect(screen.getByText('译：Edited offscreen')).toBeInTheDocument();
  });
  it('cancels quick scroll-through and unsent edits when a row leaves the viewport', async () => {
    acceptTranslationSettings(settings);
    const view = render(<Row />);
    act(() => intersection(true));
    act(() => intersection(false));
    await settle();
    expect(command).not.toHaveBeenCalled();
    await manual();
    act(() => intersection(true));
    view.rerender(<Row text="Edited before leaving" />);
    act(() => intersection(false));
    await settle();
    expect(command).toHaveBeenCalledTimes(1);
  });
  it('never displays a late old-body response over an edited message', async () => {
    let finish!: (reply: TranslationReply) => void;
    command.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<Row />);
    await manual();
    act(() => intersection(true));
    view.rerender(<Row text="Current body" />);
    await settle();
    expect(command).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ ok: true, result: { kind: 'translated', text: 'OLD RESPONSE' } });
    });
    expect(screen.queryByText('OLD RESPONSE')).not.toBeInTheDocument();
    expect(screen.getByText('译：Current body')).toBeInTheDocument();
    expect(command).toHaveBeenCalledTimes(2);
  });
  it('does not retry failed edit refreshes on rerender, but supports an explicit retry', async () => {
    const view = render(<Row />);
    await manual();
    act(() => intersection(true));
    command.mockResolvedValueOnce({ ok: false, code: 'http', status: 429 });
    view.rerender(<Row text="Edited message" />);
    await settle();
    expect(useTranslationStore.getState().automaticError?.code).toBe('http');
    view.rerender(<Row text="Edited message" />);
    await settle();
    expect(command).toHaveBeenCalledTimes(2);
    await manual();
    expect(command).toHaveBeenCalledTimes(3);
    expect(screen.getByText('译：Edited message')).toBeInTheDocument();
  });
  it('does not submit an edited message until editing ends and the window is visible', async () => {
    const view = render(<Row />);
    await manual();
    act(() => intersection(true));
    view.rerender(<Row text="Edited message" enabled={false} />);
    await settle();
    expect(command).toHaveBeenCalledTimes(1);
    view.rerender(<Row text="Edited message" />);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => intersection(true));
    await settle();
    expect(command).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await settle();
    expect(command).toHaveBeenCalledTimes(2);
  });
});
