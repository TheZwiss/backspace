import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MediaSetupHint } from './MediaSetupHint';

const DISMISSED_KEY = 'backspace_netease_smtc_hint_dismissed';
const SHOWN_KEY = 'backspace_netease_smtc_hint_shown';
const TITLE = 'Turn on SMTC in NetEase Cloud Music';

type Hint = 'netease-smtc';
let emitHint: ((hint: Hint) => void) | null = null;
let getMediaSetupHint: ReturnType<typeof vi.fn>;
let unsubscribe: ReturnType<typeof vi.fn>;

function installHost(initial: Hint | null, omit: string[] = []): void {
  emitHint = null;
  getMediaSetupHint = vi.fn(() => Promise.resolve(initial));
  unsubscribe = vi.fn();

  const api: Record<string, unknown> = {
    getMediaSetupHint,
    onMediaSetupHint: (callback: (hint: Hint) => void) => {
      emitHint = callback;
      return unsubscribe;
    },
  };
  for (const key of omit) delete api[key];
  Object.defineProperty(window, 'backspace', {
    value: api,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'backspace');
});

describe('MediaSetupHint', () => {
  it('shows a hint already reported before the renderer mounted', async () => {
    installHost('netease-smtc');

    render(<MediaSetupHint />);

    expect(await screen.findByText(TITLE)).toBeInTheDocument();
    expect(sessionStorage.getItem(SHOWN_KEY)).toBe('1');
  });

  it('shows a hint pushed after mount', async () => {
    installHost(null);

    render(<MediaSetupHint />);
    await waitFor(() => expect(getMediaSetupHint).toHaveBeenCalledOnce());
    emitHint?.('netease-smtc');

    expect(await screen.findByText(TITLE)).toBeInTheDocument();
  });

  it('does not show the hint again after a plain dismissal in the same session', async () => {
    installHost('netease-smtc');
    const first = render(<MediaSetupHint />);
    expect(await screen.findByText(TITLE)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(localStorage.getItem(DISMISSED_KEY)).toBeNull();
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();

    first.unmount();
    render(<MediaSetupHint />);
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
  });

  it('persists the opt-out only when "do not remind" is selected', async () => {
    installHost('netease-smtc');
    const first = render(<MediaSetupHint />);
    expect(await screen.findByText(TITLE)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: "Don't remind me again" }));
    await userEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('1');

    first.unmount();
    sessionStorage.clear();
    render(<MediaSetupHint />);
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
  });

  it('shows only one hint when mount effects run twice in StrictMode', async () => {
    installHost('netease-smtc');

    render(
      <StrictMode>
        <MediaSetupHint />
      </StrictMode>,
    );

    expect(await screen.findAllByText(TITLE)).toHaveLength(1);
  });

  it('does nothing when the desktop bridge predates setup hints', () => {
    installHost(null, ['getMediaSetupHint', 'onMediaSetupHint']);

    const { container } = render(<MediaSetupHint />);

    expect(container).toBeEmptyDOMElement();
  });
});
