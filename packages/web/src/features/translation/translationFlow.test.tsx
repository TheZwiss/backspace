import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MessageWithUser, User } from '@backspace/shared';
import type {
  TranslateMessageResponse,
  UpdateTranslationPreferencesRequest,
  UserTranslationStatusResponse,
} from '@backspace/shared/src/translation';

interface MockTranslationApi {
  status: ReturnType<typeof vi.fn<() => Promise<UserTranslationStatusResponse>>>;
  updatePreferences: ReturnType<typeof vi.fn<(data: UpdateTranslationPreferencesRequest) => Promise<UserTranslationStatusResponse>>>;
  clearCache: ReturnType<typeof vi.fn<() => Promise<{ cleared: number }>>>;
  translateMessage: ReturnType<typeof vi.fn<() => Promise<TranslateMessageResponse>>>;
}

function makeMockApi(): { translation: MockTranslationApi } {
  return {
    translation: {
      status: vi.fn(),
      updatePreferences: vi.fn(),
      clearCache: vi.fn().mockResolvedValue({ cleared: 0 }),
      translateMessage: vi.fn(),
    },
  };
}

const mocks = vi.hoisted(() => {
  const makeUser = (id: string, username: string): User => ({
    id,
    username,
    displayName: username,
    avatar: null,
    banner: null,
    accentColor: null,
    avatarColor: null,
    bio: null,
    status: 'online',
    customStatus: null,
    isAdmin: false,
    createdAt: 1,
    homeInstance: null,
    homeUserId: null,
    replicatedInstances: [],
  });

  const subscribers = new Set<(state: { user: User | null }, prev: { user: User | null }) => void>();
  const authState: { user: User | null } = { user: makeUser('u-alice', 'alice') };

  return {
    makeUser,
    authState,
    setAuthUser: (next: User | null) => {
      const prev = { user: authState.user };
      authState.user = next;
      for (const fn of subscribers) fn({ user: next }, prev);
    },
    subscribeAuth: (fn: (state: { user: User | null }, prev: { user: User | null }) => void) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    clientsByOrigin: new Map<string, ReturnType<typeof makeMockApi>>(),
    ui: {
      isMobile: false,
      addToast: vi.fn(),
    },
  };
});

vi.mock('../../stores/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: typeof mocks.authState) => unknown) => selector(mocks.authState),
    {
      getState: () => mocks.authState,
      subscribe: mocks.subscribeAuth,
    },
  ),
}));

vi.mock('../../stores/uiStore', () => ({
  useUIStore: Object.assign(
    (selector: (s: typeof mocks.ui) => unknown) => selector(mocks.ui),
    { getState: () => mocks.ui },
  ),
}));

vi.mock('../../utils/crossStoreResolvers', () => ({
  getApiForOrigin: (origin: string) => {
    const existing = mocks.clientsByOrigin.get(origin);
    if (!existing) throw new Error(`Missing mock client for origin "${origin}"`);
    return existing;
  },
}));

import { buildMessageMenuItems } from '../../components/chat/messageMenuItems';
import { TranslationConsentModal } from './TranslationConsentModal';
import { TranslationText } from './TranslationText';
import { resetClientTranslationState } from './translationStore';
import { useMessageTranslation } from './useMessageTranslation';

function Harness({
  origin = '',
  messageId = 'm-1',
  text = 'Bonjour le monde',
}: {
  origin?: string;
  messageId?: string;
  text?: string;
}) {
  const translation = useMessageTranslation({
    origin,
    channelId: 'ch-1',
    messageId,
    text,
    enabled: true,
  });

  const dummyMessage = {
    id: messageId,
    channelId: 'ch-1',
    userId: 'u-bob',
    content: text,
    createdAt: 1,
    user: mocks.makeUser('u-bob', 'bob'),
  } as MessageWithUser;

  const menuItems = buildMessageMenuItems({
    message: dummyMessage,
    selectedText: '',
    previousMessageId: null,
    isAuthor: false,
    isDm: false,
    canAddReactions: false,
    canSendMessages: true,
    canManageMessages: false,
    onReply: () => undefined,
    onEdit: () => undefined,
    onDelete: () => undefined,
    onReaction: () => undefined,
    onOpenEmojiPicker: () => undefined,
    onMarkUnread: () => undefined,
    onTranslate: translation.translate,
    translationStatus: translation.canTranslate
      ? {
          isTranslated: translation.isTranslated,
          showOriginal: translation.showOriginal,
          isCollapsed: translation.isCollapsed,
          toggleCollapse: translation.toggleCollapse,
        }
      : undefined,
  });

  const translateItem = menuItems.find((item) => item.key === 'translate' || item.key === 'toggle-translation');

  return (
    <div>
      {translateItem && translateItem.type === 'action' && (
        <button type="button" onClick={translateItem.onClick}>
          {translateItem.label}
        </button>
      )}
      <TranslationText translation={translation}>
        <span data-testid="original-body">{text}</span>
      </TranslationText>
      <TranslationConsentModal />
    </div>
  );
}

beforeEach(() => {
  mocks.clientsByOrigin.clear();
  mocks.setAuthUser(mocks.makeUser('u-alice', 'alice'));
  resetClientTranslationState('u-alice');
});

afterEach(() => {
  cleanup();
});

describe('single-message translation UI & consent flow', () => {
  it('stays hidden by default when instance translation is disabled', async () => {
    const homeApi = makeMockApi();
    homeApi.translation.status.mockResolvedValue({
      enabled: false,
      provider: null,
      preferences: {
        consented: false,
        consentedAt: null,
        targetLanguage: 'en',
        showOriginal: true,
      },
    });
    mocks.clientsByOrigin.set('', homeApi);

    render(<Harness />);
    await waitFor(() => expect(homeApi.translation.status).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Translate Message' })).not.toBeInTheDocument();
  });

  it('discloses provider before first transfer, waits for confirmation, and renders plain-text output', async () => {
    const homeApi = makeMockApi();
    homeApi.translation.status.mockResolvedValue({
      enabled: true,
      provider: {
        label: 'OpenAI',
        host: 'api.openai.com',
        fingerprint: 'fp-home-openai',
      },
      preferences: {
        consented: false,
        consentedAt: null,
        targetLanguage: 'en',
        showOriginal: true,
      },
    });
    homeApi.translation.updatePreferences.mockResolvedValue({
      enabled: true,
      provider: {
        label: 'OpenAI',
        host: 'api.openai.com',
        fingerprint: 'fp-home-openai',
      },
      preferences: {
        consented: true,
        consentedAt: 100,
        targetLanguage: 'en',
        showOriginal: true,
      },
    });
    homeApi.translation.translateMessage.mockResolvedValue({
      kind: 'translated',
      text: 'Hello world <img src=x onerror=alert(1)> [click](https://evil.example)',
      targetLanguage: 'en',
      cached: false,
    });
    mocks.clientsByOrigin.set('', homeApi);

    render(<Harness />);
    const menuBtn = await screen.findByRole('button', { name: 'Translate Message' });
    fireEvent.click(menuBtn);

    // Provider disclosure modal opens before any message transfer occurs.
    expect(
      await screen.findByText(/send the selected message text to OpenAI \(api\.openai\.com\)/),
    ).toBeInTheDocument();
    expect(homeApi.translation.translateMessage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Allow & Translate' }));

    await waitFor(() =>
      expect(homeApi.translation.updatePreferences).toHaveBeenCalledWith({
        consent: true,
        providerFingerprint: 'fp-home-openai',
        targetLanguage: 'en',
        showOriginal: true,
      }),
    );
    await waitFor(() =>
      expect(homeApi.translation.translateMessage).toHaveBeenCalledWith({
        channelId: 'ch-1',
        dmChannelId: undefined,
        messageId: 'm-1',
        targetLanguage: 'en',
        providerFingerprint: 'fp-home-openai',
      }),
    );

    const rendered = await screen.findByTestId('message-translation');
    expect(rendered).toHaveTextContent('Hello world <img src=x onerror=alert(1)> [click](https://evil.example)');
    expect(rendered.querySelector('img')).toBeNull();
    expect(rendered.querySelector('a')).toBeNull();

    // Switching accounts clears all in-memory translated output immediately.
    mocks.setAuthUser(mocks.makeUser('u-carol', 'carol'));
    await waitFor(() => {
      expect(screen.queryByTestId('message-translation')).not.toBeInTheDocument();
    });
  });

  it('enforces per-instance origin boundaries so home consent never authorizes a federated peer provider', async () => {
    const homeApi = makeMockApi();
    homeApi.translation.status.mockResolvedValue({
      enabled: true,
      provider: { label: 'OpenAI', host: 'api.openai.com', fingerprint: 'fp-home' },
      preferences: { consented: true, consentedAt: 50, targetLanguage: 'en', showOriginal: true },
    });

    const remoteApi = makeMockApi();
    remoteApi.translation.status.mockResolvedValue({
      enabled: true,
      provider: { label: 'Anthropic', host: 'api.anthropic.com', fingerprint: 'fp-remote' },
      preferences: { consented: false, consentedAt: null, targetLanguage: 'en', showOriginal: true },
    });

    mocks.clientsByOrigin.set('', homeApi);
    mocks.clientsByOrigin.set('https://orbit.example', remoteApi);

    render(<Harness origin="https://orbit.example/" messageId="m-remote-1" />);
    const menuBtn = await screen.findByRole('button', { name: 'Translate Message' });
    fireEvent.click(menuBtn);

    expect(
      await screen.findByText(/send the selected message text to Anthropic \(api\.anthropic\.com\)/),
    ).toBeInTheDocument();
    expect(remoteApi.translation.translateMessage).not.toHaveBeenCalled();
    expect(homeApi.translation.translateMessage).not.toHaveBeenCalled();
  });
});
