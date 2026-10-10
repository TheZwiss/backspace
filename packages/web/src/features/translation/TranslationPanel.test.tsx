import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TranslationCommand, TranslationSettings } from '@backspace/shared/translation';
import { TranslationPanel } from './TranslationPanel';
import { resetTranslationScope } from './translationStore';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../stores/authStore', () => ({ useAuthStore: Object.assign(
  (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: 'alice' } }), { subscribe: vi.fn() },
) }));
let settings: TranslationSettings;
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  delete window.backspace;
  vi.stubGlobal('location', new URL('https://home.example'));
  localStorage.setItem('backspace_token', 'test-session');
  resetTranslationScope('');
  settings = { revision: 0, connections: [], preferences: { defaultConnection: null, engine: null,
    targetLanguage: 'en', consent: false, automatic: false, showOriginal: true } };
  fetcher.mockReset().mockImplementation(async (_url, init) => {
    const command = JSON.parse(String(init?.body)) as TranslationCommand;
    if (command.action === 'saveConnection') {
      const { apiKey, ...connection } = command.connection;
      settings = { ...settings, revision: settings.revision + 1, connections: [{ ...connection, id: 'one', hasKey: !!apiKey }] };
    }
    if (command.action === 'savePreferences') settings = { ...settings, revision: settings.revision + 1, preferences: command.preferences };
    return Response.json({ ok: true, settings });
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { cleanup(); localStorage.removeItem('backspace_token'); resetTranslationScope(''); vi.unstubAllGlobals(); });

it('shows server privacy and saves a credential without a desktop client', async () => {
  render(<TranslationPanel />);
  expect(await screen.findByText('serverPrivacy')).toBeInTheDocument();
  expect(screen.queryByText('desktopOnly')).not.toBeInTheDocument();
  expect(screen.getByLabelText('automatic')).toBeDisabled();
  fireEvent.click(screen.getByText('addConnection'));
  expect(screen.getByText('serverBaseUrlHelp')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('connectionName'), { target: { value: 'Private connection' } });
  fireEvent.change(screen.getByLabelText('model'), { target: { value: 'translator' } });
  fireEvent.change(screen.getByLabelText('apiKey'), { target: { value: 'test-only-secret' } });
  fireEvent.click(screen.getByText('saveConnection'));
  await waitFor(() => expect(screen.queryByLabelText('apiKey')).not.toBeInTheDocument());
  fireEvent.click(screen.getByText('edit'));
  expect(screen.getByLabelText('apiKey')).toHaveValue('');
  expect(screen.getByLabelText('apiKey')).toHaveAttribute('type', 'password');
  expect(screen.getByLabelText('apiKey')).toHaveAttribute('placeholder', 'keyStored');
});
it('requires server consent and supports automatic translation with replacement display', async () => {
  render(<TranslationPanel />);
  fireEvent.click(await screen.findByLabelText('serverConsent'));
  fireEvent.click(screen.getByLabelText('automatic'));
  fireEvent.click(screen.getByLabelText('showOriginal'));
  fireEvent.click(screen.getByText('savePreferences'));
  await waitFor(() => expect(settings.preferences).toMatchObject({ consent: true, automatic: true, showOriginal: false }));
  expect(screen.getByText('serverAutomaticHelp')).toBeInTheDocument();
});

it('runs model discovery and a live test through the Web bridge without saving drafts', async () => {
  render(<TranslationPanel />);
  fireEvent.click(await screen.findByText('addConnection'));
  fireEvent.change(screen.getByLabelText('apiKey'), { target: { value: 'draft-test-key' } });
  fetcher.mockResolvedValueOnce(Response.json({ ok: true, models: ['chat-draft'] }));
  fireEvent.click(screen.getByText('fetchModels'));
  fireEvent.change(await screen.findByLabelText('availableModels'), { target: { value: 'chat-draft' } });
  fetcher.mockResolvedValueOnce(Response.json({ ok: true, test: { text: 'Hi! Can you take a look?', latencyMs: 25 } }));
  fireEvent.click(screen.getByText('testConnection'));
  expect(await screen.findByText('connectionReady')).toBeInTheDocument();
  const commands = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as TranslationCommand);
  expect(commands.map(command => command.action)).toEqual(['load', 'listModels', 'testConnection']);
  expect(commands[2]).toMatchObject({ accountId: 'alice', connection: { apiKey: 'draft-test-key', model: 'chat-draft' } });
  expect(settings).toMatchObject({ revision: 0, connections: [], preferences: { consent: false } });
});
