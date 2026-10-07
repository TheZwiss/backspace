import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PASSWORD_MIN_LENGTH } from '@backspace/shared/src/constants';
import { setLanguage } from '../../i18n';
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
        // Pending metadata leaves registration treated as open, so step 1 is
        // gated only by the credential checks under test.
        info: vi.fn(() => new Promise(() => {})),
      },
      auth: {
        checkInvite: vi.fn(),
        checkUsername: vi.fn(async () => ({ available: true })),
        register: vi.fn(),
      },
      users: {
        update: vi.fn(),
      },
    },
  };
});

function renderRegisterPage(): HTMLElement {
  const { container } = render(
    <MemoryRouter initialEntries={['/register']}>
      <RegisterPage />
    </MemoryRouter>,
  );
  return container;
}

function credentialInputs(container: HTMLElement): {
  username: HTMLInputElement;
  password: HTMLInputElement;
  confirm: HTMLInputElement;
} {
  const username = container.querySelector<HTMLInputElement>('input[autocomplete="username"]');
  const passwords = container.querySelectorAll<HTMLInputElement>('input[autocomplete="new-password"]');
  if (!username || passwords.length !== 2) {
    throw new Error('registration step 1 did not render its credential fields');
  }
  return { username, password: passwords[0], confirm: passwords[1] };
}

// #397: step 1 accepted a 6-character password that the server then refused
// at step 2 with an 8-character minimum. Both now read PASSWORD_MIN_LENGTH.
describe('registration password minimum', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await setLanguage('en');
  });

  it('refuses a password one character under the shared minimum at step 1 and names that minimum', async () => {
    const user = userEvent.setup();
    const container = renderRegisterPage();
    const { username, password, confirm } = credentialInputs(container);
    const tooShort = 'a'.repeat(PASSWORD_MIN_LENGTH - 1);

    await user.type(username, 'alice');
    await user.type(password, tooShort);
    await user.type(confirm, tooShort);
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByText(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`)).toBeInTheDocument();
    // Step 2's display-name field takes the username as its placeholder.
    expect(screen.queryByPlaceholderText('alice')).not.toBeInTheDocument();
  });

  it('moves to step 2 with a password of exactly the shared minimum', async () => {
    const user = userEvent.setup();
    const container = renderRegisterPage();
    const { username, password, confirm } = credentialInputs(container);
    const atMinimum = 'a'.repeat(PASSWORD_MIN_LENGTH);

    await user.type(username, 'alice');
    await user.type(password, atMinimum);
    await user.type(confirm, atMinimum);
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByPlaceholderText('alice')).toBeInTheDocument();
    expect(screen.queryByText(/Password must be at least/)).not.toBeInTheDocument();
  });
});
