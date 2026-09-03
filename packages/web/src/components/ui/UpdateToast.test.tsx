import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdateToast } from './UpdateToast';
import { useUpdateStore } from '../../stores/updateStore';
import { useUIStore } from '../../stores/uiStore';

interface HostStubs {
  dismissUpdate: ReturnType<typeof vi.fn>;
  installUpdate: ReturnType<typeof vi.fn>;
  openReleasePage: ReturnType<typeof vi.fn>;
}

let push: ((snapshot: unknown) => void) | null = null;
let stubs: HostStubs;

/**
 * Installs a fake preload bridge. `initial` is what getUpdateStatus resolves
 * with; `omit` drops methods to simulate an older desktop app.
 */
function installHost(initial: unknown, omit: string[] = []): void {
  stubs = {
    dismissUpdate: vi.fn(),
    installUpdate: vi.fn(),
    openReleasePage: vi.fn(),
  };
  const api: Record<string, unknown> = {
    platform: 'darwin',
    getVersion: () => Promise.resolve('1.0.3'),
    getUpdateStatus: () => Promise.resolve(initial),
    onUpdateStatusChanged: (cb: (s: unknown) => void) => {
      push = cb;
      return () => { push = null; };
    },
    dismissUpdate: stubs.dismissUpdate,
    installUpdate: stubs.installUpdate,
    openReleasePage: stubs.openReleasePage,
    checkForUpdates: vi.fn(),
    onUpdateDownloaded: vi.fn(),
    onUpdateError: vi.fn(),
  };
  for (const key of omit) delete api[key];
  Object.defineProperty(window, 'backspace', { value: api, configurable: true, writable: true });
}

beforeEach(() => {
  push = null;
  useUpdateStore.setState({ snapshot: null, currentVersion: null, legacyBridge: false });
  useUIStore.setState({ toasts: [] });
});

afterEach(() => {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'backspace');
});

describe('UpdateToast, ad-hoc signed macOS build', () => {
  beforeEach(() => {
    installHost({
      capability: 'manual',
      dismissedVersion: null,
      status: { phase: 'available', version: '1.0.4' },
    });
  });

  it('offers Download and never a Restart button', async () => {
    render(<UpdateToast />);
    expect(await screen.findByText('Backspace 1.0.4 is available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart now' })).not.toBeInTheDocument();
  });

  it('says in plain words that the build cannot update itself', async () => {
    render(<UpdateToast />);
    expect(await screen.findByText(/cannot update itself/i)).toBeInTheDocument();
  });

  it('names the version the user is currently on', async () => {
    render(<UpdateToast />);
    expect(await screen.findByText(/You are on 1\.0\.3/)).toBeInTheDocument();
  });

  it('opens the download page through the host, not a raw link', async () => {
    render(<UpdateToast />);
    await userEvent.click(await screen.findByRole('button', { name: 'Download' }));
    expect(stubs.openReleasePage).toHaveBeenCalledOnce();
  });
});

describe('UpdateToast, installable build', () => {
  beforeEach(() => {
    installHost({
      capability: 'auto',
      dismissedVersion: null,
      status: { phase: 'ready', version: '1.0.4' },
    });
  });

  it('offers Restart now', async () => {
    render(<UpdateToast />);
    expect(await screen.findByText('Update ready')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    expect(stubs.installUpdate).toHaveBeenCalledOnce();
  });

  it('does not truncate the body copy', async () => {
    render(<UpdateToast />);
    const body = await screen.findByText(/is downloaded and ready to install/);
    expect(body.className).not.toContain('truncate');
  });

  it('uses the glass-bubble surface tier, not glass-pill', async () => {
    const { container } = render(<UpdateToast />);
    await screen.findByText('Update ready');
    expect(container.querySelector('.glass-bubble')).not.toBeNull();
    expect(container.querySelector('.glass-pill')).toBeNull();
  });
});

describe('UpdateToast, latest event wins', () => {
  it('replaces a ready state with a later failure instead of hiding it behind one', async () => {
    // The reported defect: "Update ready" masked "Update failed" until the user
    // dismissed the card in front of it.
    installHost({
      capability: 'auto',
      dismissedVersion: null,
      status: { phase: 'ready', version: '1.0.4' },
    });
    render(<UpdateToast />);
    await screen.findByText('Update ready');

    push!({
      capability: 'auto',
      dismissedVersion: null,
      status: { phase: 'failed', version: '1.0.4', message: 'Squirrel refused the update' },
    });

    expect(await screen.findByText('Update could not be installed')).toBeInTheDocument();
    expect(screen.queryByText('Update ready')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });
});

describe('UpdateToast, dismissal', () => {
  it('reports the dismissal to the host and points at where the update lives', async () => {
    installHost({
      capability: 'manual',
      dismissedVersion: null,
      status: { phase: 'available', version: '1.0.4' },
    });
    render(<UpdateToast />);
    await userEvent.click(await screen.findByRole('button', { name: 'Later' }));

    expect(stubs.dismissUpdate).toHaveBeenCalledWith('1.0.4');
    expect(useUIStore.getState().toasts.map((t) => t.message))
      .toContain('You can install this later from Settings, Desktop');
  });

  it('renders nothing for a version already dismissed', async () => {
    installHost({
      capability: 'manual',
      dismissedVersion: '1.0.4',
      status: { phase: 'available', version: '1.0.4' },
    });
    const { container } = render(<UpdateToast />);
    await waitFor(() => expect(useUpdateStore.getState().snapshot).not.toBeNull());
    expect(container).toBeEmptyDOMElement();
  });

  it('still renders for a version newer than the dismissed one', async () => {
    installHost({
      capability: 'manual',
      dismissedVersion: '1.0.4',
      status: { phase: 'available', version: '1.0.5' },
    });
    render(<UpdateToast />);
    expect(await screen.findByText('Backspace 1.0.5 is available')).toBeInTheDocument();
  });
});

describe('UpdateToast, quiet phases', () => {
  it.each([
    ['idle', { phase: 'idle' }],
    ['checking', { phase: 'checking' }],
    ['downloading', { phase: 'downloading', version: '1.0.4', percent: 40, bytesPerSecond: 1 }],
    ['up-to-date', { phase: 'up-to-date', checkedAt: 1 }],
  ])('renders nothing while %s', async (_label, status) => {
    installHost({ capability: 'auto', dismissedVersion: null, status });
    const { container } = render(<UpdateToast />);
    await waitFor(() => expect(useUpdateStore.getState().snapshot).not.toBeNull());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a check failure with no version', async () => {
    installHost({
      capability: 'auto',
      dismissedVersion: null,
      status: { phase: 'failed', version: null, message: 'ENOTFOUND' },
    });
    const { container } = render(<UpdateToast />);
    await waitFor(() => expect(useUpdateStore.getState().snapshot).not.toBeNull());
    expect(container).toBeEmptyDOMElement();
  });
});

describe('UpdateToast, outside Electron', () => {
  it('renders nothing in a browser', () => {
    const { container } = render(<UpdateToast />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('UpdateToast, older desktop app', () => {
  it('falls back to the legacy channels rather than crashing', async () => {
    // A client served by a newer instance, running inside a pre-1.0.5 app that
    // has no snapshot API at all.
    installHost(null, ['getUpdateStatus', 'onUpdateStatusChanged', 'dismissUpdate', 'openReleasePage']);
    let legacyDownloaded: ((info: { version: string }) => void) | null = null;
    (window.backspace as unknown as Record<string, unknown>).onUpdateDownloaded =
      (cb: (info: { version: string }) => void) => { legacyDownloaded = cb; };

    render(<UpdateToast />);
    await waitFor(() => expect(legacyDownloaded).not.toBeNull());

    legacyDownloaded!({ version: '1.0.4' });
    expect(await screen.findByText('Update ready')).toBeInTheDocument();
    expect(useUpdateStore.getState().legacyBridge).toBe(true);
  });
});
