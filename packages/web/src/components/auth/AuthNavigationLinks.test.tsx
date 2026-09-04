import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setLanguage } from '../../i18n';
import { LoginPage } from './LoginPage';
import { RegisterPage } from './RegisterPage';

const authState = {
  login: vi.fn(),
  isLoading: false,
  initSession: vi.fn(),
};

vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (state: typeof authState) => unknown) => selector(authState),
}));

vi.mock('../../stores/transferStore', () => ({
  useTransferStore: {
    getState: () => ({ startUpload: vi.fn() }),
  },
}));

vi.mock('../../api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../api/client')>();
  return {
    ...original,
    api: {
      instance: {
        // Keep instance metadata pending: neither navigation prompt depends on it,
        // and avoiding a state update keeps these tests focused on link semantics.
        info: vi.fn(() => new Promise(() => {})),
      },
      auth: {
        checkInvite: vi.fn(),
        checkUsername: vi.fn(),
        register: vi.fn(),
      },
      users: {
        update: vi.fn(),
      },
    },
  };
});

describe('authentication navigation prompts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['en', 'Register'],
    ['de', 'Registrieren'],
    ['ru', 'Зарегистрироваться'],
  ] as const)('navigates from login to registration in %s', async (language, linkLabel) => {
    await setLanguage(language);
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/login?redirect=%2Fchannels%2F%40me']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<div>Registration destination</div>} />
        </Routes>
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: linkLabel });
    expect(link).toHaveAttribute('href', '/register?redirect=%2Fchannels%2F%40me');

    await user.click(link);
    expect(screen.getByText('Registration destination')).toBeInTheDocument();
  });

  it.each([
    ['en', 'Log In'],
    ['de', 'Anmelden'],
    ['ru', 'Войти'],
  ] as const)('navigates from registration to login in %s', async (language, linkLabel) => {
    await setLanguage(language);
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/register?redirect=%2Fchannels%2F%40me']}>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/login" element={<div>Login destination</div>} />
        </Routes>
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: linkLabel });
    expect(link).toHaveAttribute('href', '/login?redirect=%2Fchannels%2F%40me');

    await user.click(link);
    expect(screen.getByText('Login destination')).toBeInTheDocument();
  });
});
