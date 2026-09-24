import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom.
// Reached transitively via authStore -> voiceStore.
vi.mock('./audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

// Only the routing is under test: every routed surface is a stub that says
// which route it was rendered for.
vi.mock('./components/layout/AppLayout', async () => {
  const { useLocation } = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    AppLayout: () => {
      const location = useLocation();
      return <div data-testid="layout">{location.pathname}</div>;
    },
  };
});
vi.mock('./components/auth/LoginPage', () => ({ LoginPage: () => <div data-testid="login" /> }));
vi.mock('./components/auth/RegisterPage', () => ({ RegisterPage: () => <div data-testid="register" /> }));
vi.mock('./components/JoinPage', () => ({ JoinPage: () => <div data-testid="join" /> }));
vi.mock('./components/ui/SwUpdatePrompt', () => ({ SwAutoUpdate: () => null }));
vi.mock('./components/telemetry/TelemetryAsk', () => ({ TelemetryAsk: () => null }));
vi.mock('./components/voice/ScreenShareSetup', () => ({ ScreenShareSetup: () => null }));

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import { App } from './App';

function renderAt(pathname: string) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <App />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useAuthStore.setState({ token: 'token' });
});

afterEach(() => {
  useAuthStore.setState({ token: null });
});

describe('App routes', () => {
  it('serves /backspace inside the app layout', () => {
    renderAt('/backspace');
    expect(screen.getByTestId('layout')).toHaveTextContent(/^\/backspace$/);
  });

  it('still serves /explore inside the app layout', () => {
    renderAt('/explore');
    expect(screen.getByTestId('layout')).toHaveTextContent(/^\/explore$/);
  });

  it('sends a signed-out visitor of /backspace to the login page', () => {
    useAuthStore.setState({ token: null });
    renderAt('/backspace');
    expect(screen.getByTestId('login')).toBeInTheDocument();
  });
});
