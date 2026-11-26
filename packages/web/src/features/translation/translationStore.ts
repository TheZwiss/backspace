import { create } from 'zustand';
import type {
  TranslateMessageResponse,
  TranslationLanguage,
  UserTranslationProviderSummary,
  UserTranslationStatusResponse,
} from '@backspace/shared/src/translation';
import { HttpError } from '../../api/client';
import { describeError } from '../../i18n/errors';
import { useAuthStore } from '../../stores/authStore';
import { getApiForOrigin } from '../../utils/crossStoreResolvers';

export type TranslationEntry =
  | { state: 'loading' }
  | { state: 'done'; result: TranslateMessageResponse }
  | { state: 'error'; message: string };

export interface PendingTranslateTarget {
  origin: string;
  channelId?: string;
  dmChannelId?: string;
  messageId: string;
  messageContent: string;
}

export interface PendingConsentPrompt {
  origin: string;
  provider: UserTranslationProviderSummary;
  targetLanguage: TranslationLanguage;
  showOriginal: boolean;
  submitting: boolean;
  error: string;
  target: PendingTranslateTarget;
}

interface TranslationState {
  sessionUserId: string;
  statuses: Record<string, UserTranslationStatusResponse>;
  entries: Record<string, TranslationEntry>;
  pendingConsent: PendingConsentPrompt | null;
}

const ENTRY_CACHE_LIMIT = 200;
const inflightStatuses = new Map<string, Promise<UserTranslationStatusResponse>>();

export const useTranslationStore = create<TranslationState>(() => ({
  sessionUserId: '',
  statuses: {},
  entries: {},
  pendingConsent: null,
}));

export function normalizeInstanceOrigin(origin: string): string {
  let end = origin.length;
  while (end > 0 && origin.charCodeAt(end - 1) === 47) end -= 1;
  return origin.slice(0, end);
}

export function statusScopeKey(userId: string, origin: string): string {
  return `${userId}\n${normalizeInstanceOrigin(origin)}`;
}

export function messageEntryKey(input: {
  userId: string;
  origin: string;
  channelKey: string;
  messageId: string;
  content: string;
  targetLanguage: TranslationLanguage;
}): string {
  return JSON.stringify([
    input.userId,
    normalizeInstanceOrigin(input.origin),
    input.channelKey,
    input.messageId,
    input.targetLanguage,
    input.content,
  ]);
}

export function resetClientTranslationState(sessionUserId = ''): void {
  inflightStatuses.clear();
  useTranslationStore.setState({
    sessionUserId,
    statuses: {},
    entries: {},
    pendingConsent: null,
  });
}

function defaultDisabledStatus(): UserTranslationStatusResponse {
  return {
    enabled: false,
    provider: null,
    preferences: {
      consented: false,
      consentedAt: null,
      targetLanguage: 'en',
      showOriginal: true,
    },
  };
}

function setEntryBounded(key: string, entry: TranslationEntry): void {
  const next = { ...useTranslationStore.getState().entries, [key]: entry };
  const keys = Object.keys(next);
  if (keys.length > ENTRY_CACHE_LIMIT) {
    delete next[keys[0]!];
  }
  useTranslationStore.setState({ entries: next });
}

export async function ensureOriginTranslationStatus(
  origin: string,
  forceReload = false,
): Promise<UserTranslationStatusResponse> {
  const userId = useAuthStore.getState().user?.id ?? '';
  if (!userId) return defaultDisabledStatus();

  if (useTranslationStore.getState().sessionUserId !== userId) {
    resetClientTranslationState(userId);
  }

  const key = statusScopeKey(userId, origin);
  const cached = useTranslationStore.getState().statuses[key];
  if (!forceReload && cached) return cached;

  const existingPromise = inflightStatuses.get(key);
  if (!forceReload && existingPromise) return existingPromise;

  const task = (async (): Promise<UserTranslationStatusResponse> => {
    try {
      const client = getApiForOrigin(normalizeInstanceOrigin(origin));
      const status = await client.translation.status();
      if (useAuthStore.getState().user?.id === userId) {
        useTranslationStore.setState((s) => ({
          statuses: { ...s.statuses, [key]: status },
        }));
      }
      return status;
    } catch {
      // Older federated instances without /translation/status or offline instances stay disabled cleanly.
      const fallback = defaultDisabledStatus();
      if (useAuthStore.getState().user?.id === userId) {
        useTranslationStore.setState((s) => ({
          statuses: { ...s.statuses, [key]: fallback },
        }));
      }
      return fallback;
    } finally {
      inflightStatuses.delete(key);
    }
  })();

  inflightStatuses.set(key, task);
  return task;
}

async function runAuthorizedTranslation(
  target: PendingTranslateTarget,
  status: UserTranslationStatusResponse,
): Promise<void> {
  const userId = useAuthStore.getState().user?.id ?? '';
  if (!userId || !status.enabled || !status.provider) return;

  const channelKey = target.channelId || target.dmChannelId || '';
  const key = messageEntryKey({
    userId,
    origin: target.origin,
    channelKey,
    messageId: target.messageId,
    content: target.messageContent,
    targetLanguage: status.preferences.targetLanguage,
  });

  if (useTranslationStore.getState().entries[key]?.state === 'loading') return;
  setEntryBounded(key, { state: 'loading' });

  try {
    const client = getApiForOrigin(normalizeInstanceOrigin(target.origin));
    const result = await client.translation.translateMessage({
      channelId: target.channelId,
      dmChannelId: target.dmChannelId,
      messageId: target.messageId,
      targetLanguage: status.preferences.targetLanguage,
      providerFingerprint: status.provider.fingerprint,
    });
    if (useAuthStore.getState().user?.id !== userId) return;
    setEntryBounded(key, { state: 'done', result });
  } catch (error) {
    if (useAuthStore.getState().user?.id !== userId) return;
    if (error instanceof HttpError && error.code === 'translation_consent_required') {
      // Provider changed since status was loaded: refresh status and prompt consent before sending.
      const nextEntries = { ...useTranslationStore.getState().entries };
      delete nextEntries[key];
      useTranslationStore.setState({ entries: nextEntries });
      const refreshed = await ensureOriginTranslationStatus(target.origin, true);
      if (refreshed.enabled && refreshed.provider) {
        useTranslationStore.setState({
          pendingConsent: {
            origin: normalizeInstanceOrigin(target.origin),
            provider: refreshed.provider,
            targetLanguage: refreshed.preferences.targetLanguage,
            showOriginal: refreshed.preferences.showOriginal,
            submitting: false,
            error: '',
            target,
          },
        });
      }
      return;
    }
    setEntryBounded(key, { state: 'error', message: describeError(error) });
  }
}

/**
 * Invoked only on an explicit user click to translate a single message.
 * Opens the first-transfer disclosure dialog whenever the user has not yet
 * consented to the instance's currently configured provider.
 */
export async function requestSingleMessageTranslation(target: PendingTranslateTarget): Promise<void> {
  const status = await ensureOriginTranslationStatus(target.origin);
  if (!status.enabled || !status.provider) return;

  if (!status.preferences.consented) {
    useTranslationStore.setState({
      pendingConsent: {
        origin: normalizeInstanceOrigin(target.origin),
        provider: status.provider,
        targetLanguage: status.preferences.targetLanguage,
        showOriginal: status.preferences.showOriginal,
        submitting: false,
        error: '',
        target,
      },
    });
    return;
  }

  await runAuthorizedTranslation(target, status);
}

export async function confirmFirstTransferAndTranslate(options: {
  targetLanguage: TranslationLanguage;
  showOriginal: boolean;
}): Promise<void> {
  const pending = useTranslationStore.getState().pendingConsent;
  const userId = useAuthStore.getState().user?.id ?? '';
  if (!pending || !userId || pending.submitting) return;

  useTranslationStore.setState({
    pendingConsent: { ...pending, submitting: true, error: '' },
  });

  try {
    const client = getApiForOrigin(pending.origin);
    const updated = await client.translation.updatePreferences({
      consent: true,
      providerFingerprint: pending.provider.fingerprint,
      targetLanguage: options.targetLanguage,
      showOriginal: options.showOriginal,
    });
    if (useAuthStore.getState().user?.id !== userId) return;

    const key = statusScopeKey(userId, pending.origin);
    useTranslationStore.setState((s) => ({
      statuses: { ...s.statuses, [key]: updated },
      pendingConsent: null,
    }));

    await runAuthorizedTranslation(pending.target, updated);
  } catch (error) {
    useTranslationStore.setState((s) =>
      s.pendingConsent
        ? {
            pendingConsent: {
              ...s.pendingConsent,
              submitting: false,
              error: describeError(error),
            },
          }
        : {},
    );
  }
}

export function dismissConsentPrompt(): void {
  useTranslationStore.setState({ pendingConsent: null });
}

export function clearOriginMemoryEntries(origin: string): void {
  const normalized = normalizeInstanceOrigin(origin);
  const current = useTranslationStore.getState().entries;
  const filtered: Record<string, TranslationEntry> = {};
  for (const [k, v] of Object.entries(current)) {
    try {
      const parsed = JSON.parse(k) as unknown[];
      if (parsed[1] !== normalized) filtered[k] = v;
    } catch {
      // Drop malformed entry keys
    }
  }
  useTranslationStore.setState({ entries: filtered });
}

// Immediately clear all in-memory translated message state on account switch or logout.
useAuthStore.subscribe((state, prev) => {
  if (state.user?.id !== prev.user?.id) {
    resetClientTranslationState(state.user?.id ?? '');
  }
});
