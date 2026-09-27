import { describe, it, expect, vi, afterEach } from 'vitest';
import { Component, type ReactNode } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { lazyPanel, SettingsPanelSuspense } from './lazySettingsPanels';

const FAILED = 'Could not load the settings.';
const RELOAD = 'Reload Page';

/** Stands in for the root ErrorBoundary: records what escapes the panel boundary. */
class Outer extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? <div>outer caught: {this.state.error.message}</div> : this.props.children;
  }
}

function Sibling() {
  return <div>still mounted</div>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SettingsPanelSuspense', () => {
  it('shows the panel once its chunk loads', async () => {
    const Panel = lazyPanel(() => Promise.resolve({ Loaded: () => <div>panel body</div> }), (m) => m.Loaded);
    render(<Outer><Sibling /><SettingsPanelSuspense><Panel /></SettingsPanelSuspense></Outer>);
    expect(await screen.findByText('panel body')).toBeInTheDocument();
  });

  it('keeps a failed chunk load inside the panel area', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Panel = lazyPanel(
      () => Promise.reject<{ Broken: () => ReactNode }>(new TypeError('Failed to fetch dynamically imported module')),
      (m) => m.Broken,
    );
    render(<Outer><Sibling /><SettingsPanelSuspense><Panel /></SettingsPanelSuspense></Outer>);
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(screen.getByText('still mounted')).toBeInTheDocument();
    expect(screen.queryByText(/outer caught/)).not.toBeInTheDocument();
  });

  it('offers a page reload from the failed state', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload });
    const Panel = lazyPanel(() => Promise.reject<{ P: () => ReactNode }>(new Error('404')), (m) => m.P);
    render(<SettingsPanelSuspense><Panel /></SettingsPanelSuspense>);
    fireEvent.click(await screen.findByRole('button', { name: RELOAD }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('lets a render error that is not a chunk load reach the outer boundary', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Throws(): ReactNode {
      throw new Error('panel bug');
    }
    render(<Outer><SettingsPanelSuspense><Throws /></SettingsPanelSuspense></Outer>);
    expect(await screen.findByText('outer caught: panel bug')).toBeInTheDocument();
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument();
  });
});
