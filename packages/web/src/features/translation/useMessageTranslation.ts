import { useEffect, useState } from 'react';
import { MAX_TRANSLATION_SOURCE_LENGTH } from '@backspace/shared/src/translation';
import { useAuthStore } from '../../stores/authStore';
import {
  ensureOriginTranslationStatus,
  messageEntryKey,
  normalizeInstanceOrigin,
  requestSingleMessageTranslation,
  statusScopeKey,
  useTranslationStore,
} from './translationStore';

export function useMessageTranslation(input: {
  origin: string;
  channelId?: string;
  dmChannelId?: string;
  messageId: string;
  text: string;
  enabled: boolean;
}) {
  const userId = useAuthStore((s) => s.user?.id ?? '');
  const normalizedOrigin = normalizeInstanceOrigin(input.origin);
  const scopeKey = userId ? statusScopeKey(userId, normalizedOrigin) : '';
  const status = useTranslationStore((s) => (scopeKey ? s.statuses[scopeKey] : undefined));

  useEffect(() => {
    if (!userId || !input.enabled) return;
    void ensureOriginTranslationStatus(normalizedOrigin);
  }, [userId, normalizedOrigin, input.enabled]);

  const targetLanguage = status?.preferences.targetLanguage ?? 'en';
  const channelKey = input.channelId || input.dmChannelId || '';
  const entryKey = userId
    ? messageEntryKey({
        userId,
        origin: normalizedOrigin,
        channelKey,
        messageId: input.messageId,
        content: input.text,
        targetLanguage,
      })
    : '';

  const entry = useTranslationStore((s) => (entryKey ? s.entries[entryKey] : undefined));

  const [isCollapsed, setIsCollapsed] = useState(false);
  useEffect(() => {
    setIsCollapsed(false);
  }, [entryKey]);

  const canTranslate = Boolean(
    input.enabled &&
      status?.enabled &&
      input.text &&
      input.text.length <= MAX_TRANSLATION_SOURCE_LENGTH &&
      /\p{L}/u.test(input.text),
  );

  const translate = () => {
    if (!canTranslate) return;
    setIsCollapsed(false);
    void requestSingleMessageTranslation({
      origin: normalizedOrigin,
      channelId: input.channelId,
      dmChannelId: input.dmChannelId,
      messageId: input.messageId,
      messageContent: input.text,
    });
  };

  const isTranslated = Boolean(
    status?.enabled && entry?.state === 'done' && entry.result.kind === 'translated',
  );

  return {
    entry: canTranslate ? entry : undefined,
    canTranslate,
    translate: canTranslate ? translate : undefined,
    showOriginal: status?.preferences.showOriginal ?? true,
    isTranslated,
    isCollapsed,
    toggleCollapse: () => setIsCollapsed((v) => !v),
  };
}
