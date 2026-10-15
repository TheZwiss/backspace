import { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../components/ui/Modal';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useTranslationSettings } from './useMessageTranslation';
import { sendTranslationCommand } from './translationStore';
import { translationErrorText } from './errorText';
import { getTargetLanguageName } from './composerPresets';
import { getLanguage } from '../../i18n';
import { ChatDatePicker } from './ChatDatePicker';
import type { MessageWithUser } from '@backspace/shared';

const EMPTY_MESSAGES: MessageWithUser[] = [];

export type SummaryScopeMode = 'unread' | 'date';

function getTodayIsoDate(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const MAX_CACHE_ENTRIES = 100;
export const summaryCache = new Map<string, string>();

export function getSummaryCacheKey(
  channelId: string,
  mode: SummaryScopeMode,
  selectedDate: string,
  lastReadId: string | null | undefined,
  targetLang: string,
): string {
  const scope = mode === 'date' ? selectedDate : (lastReadId ?? 'latest');
  return `${channelId}:${mode}:${scope}:${targetLang}`;
}

export function setCachedSummary(key: string, text: string): void {
  if (summaryCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = summaryCache.keys().next().value;
    if (oldestKey !== undefined) summaryCache.delete(oldestKey);
  }
  summaryCache.set(key, text);
}

export function filterSummaryMessages(
  messages: MessageWithUser[],
  mode: SummaryScopeMode,
  options: { lastReadId?: string | null; selectedDate?: string },
): MessageWithUser[] {
  const eligible = messages.filter((m) => !!m.content && !m.id.startsWith('temp_'));
  if (mode === 'date') {
    const targetDate = options.selectedDate ?? getTodayIsoDate();
    const dayStart = new Date(`${targetDate}T00:00:00`).getTime();
    const dayEnd = new Date(`${targetDate}T23:59:59.999`).getTime();
    return eligible.filter((m) => m.createdAt >= dayStart && m.createdAt <= dayEnd);
  }
  // Mode unread
  if (options.lastReadId) {
    const idx = eligible.findIndex((m) => m.id === options.lastReadId);
    if (idx !== -1) {
      return eligible.slice(idx + 1);
    }
  }
  return eligible;
}

interface ChatSummaryModalProps {
  isOpen: boolean;
  onClose: () => void;
  channelId: string;
  channelName: string;
}

export function ChatSummaryModal({ isOpen, onClose, channelId, channelName }: ChatSummaryModalProps) {
  const { t, i18n } = useTranslation('translation');
  const { accountId, settings } = useTranslationSettings();
  const targetLang = i18n?.resolvedLanguage ?? i18n?.language ?? getLanguage();
  const messages = useChatStore((s) => s.messages.get(channelId)) ?? EMPTY_MESSAGES;
  const readStates = useChatStore((s) => s.readStates);
  const lastReadId = readStates.get(channelId);

  const [mode, setMode] = useState<SummaryScopeMode>('unread');
  const [selectedDate, setSelectedDate] = useState<string>(getTodayIsoDate);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<string | null>(() => {
    const key = getSummaryCacheKey(channelId, 'unread', getTodayIsoDate(), lastReadId, targetLang);
    return summaryCache.get(key) ?? null;
  });
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const currentFilteredMessages = useMemo(
    () => filterSummaryMessages(messages, mode, { lastReadId, selectedDate }),
    [messages, mode, lastReadId, selectedDate],
  );

  const messageDates = useMemo(() => {
    const dates = new Set<string>();
    for (const m of messages) {
      if (m.content && !m.id.startsWith('temp_')) {
        const d = new Date(m.createdAt);
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        dates.add(`${year}-${month}-${day}`);
      }
    }
    return dates;
  }, [messages]);

  const handleModeChange = useCallback(
    (newMode: SummaryScopeMode) => {
      setMode(newMode);
      setError(null);
      const key = getSummaryCacheKey(channelId, newMode, selectedDate, lastReadId, targetLang);
      const cached = summaryCache.get(key);
      setSummary(cached ?? null);
    },
    [channelId, selectedDate, lastReadId, targetLang],
  );

  const handleDateChange = useCallback(
    (newDate: string) => {
      setSelectedDate(newDate);
      setError(null);
      const key = getSummaryCacheKey(channelId, 'date', newDate, lastReadId, targetLang);
      const cached = summaryCache.get(key);
      setSummary(cached ?? null);
    },
    [channelId, lastReadId, targetLang],
  );

  useEffect(() => {
    if (isOpen) {
      const key = getSummaryCacheKey(channelId, mode, selectedDate, lastReadId, targetLang);
      const cached = summaryCache.get(key);
      if (cached && !summary) {
        setSummary(cached);
      }
    }
  }, [isOpen, channelId, mode, selectedDate, lastReadId, targetLang, summary]);

  const handleGenerate = useCallback(async () => {
    if (!accountId) return;

    if (messages.length === 0) {
      setError(t('noMessagesToSummarize'));
      return;
    }

    if (currentFilteredMessages.length === 0) {
      setError(mode === 'unread' ? t('noUnreadMessages') : t('noDateMessages'));
      return;
    }

    setLoading(true);
    setError(null);

    // Safeguard: take up to 80 messages, cap dialogue string at 25,000 characters
    const dialogue = currentFilteredMessages
      .slice(-80)
      .map((m) => `${m.user.displayName || m.user.username}: ${m.content}`)
      .join('\n')
      .slice(-25000);

    const targetLangName = getTargetLanguageName(targetLang);

    const systemPrompt =
      `You are a professional chat conversation summarizer. Extract and organize a structured discussion summary from the provided group or direct message chat history.\n` +
      `Language requirement: You MUST output the summary strictly in ${targetLangName}.\n` +
      `Format clearly with:\n` +
      `1. Key Discussion Points\n` +
      `2. Decisions and Consensus Reached\n` +
      `3. Action Items / Next Steps (with assignees if mentioned)\n` +
      `Keep the tone concise, accurate, and natural.`;

    const scopeDesc =
      mode === 'unread' ? 'unread messages' : `messages from ${selectedDate}`;

    const userPrompt = `Here is the chat history for "${channelName}" (${scopeDesc}, in chronological order):\n\n${dialogue}\n\nPlease generate a structured summary:`;

    const reply = await sendTranslationCommand({
      action: 'aiGenerate',
      accountId,
      systemPrompt,
      userPrompt,
      connectionId: settings?.preferences.summarizerConnection,
    });

    setLoading(false);
    if (reply.ok && 'outputText' in reply) {
      setSummary(reply.outputText);
      const key = getSummaryCacheKey(channelId, mode, selectedDate, lastReadId, targetLang);
      setCachedSummary(key, reply.outputText);
    } else if (!reply.ok) {
      setError(translationErrorText(reply));
    }
  }, [
    accountId,
    channelId,
    channelName,
    currentFilteredMessages,
    lastReadId,
    messages.length,
    mode,
    selectedDate,
    settings?.preferences.summarizerConnection,
    targetLang,
    t,
  ]);

  useEffect(() => {
    const cacheKey = getSummaryCacheKey(channelId, mode, selectedDate, lastReadId, targetLang);
    const cached = summaryCache.get(cacheKey);
    if (cached && !summary) {
      setSummary(cached);
      return;
    }
    // Only auto-generate in 'unread' mode if not already cached; in 'date' mode user explicitly triggers via generate button
    if (isOpen && mode === 'unread' && !summary && !cached && !loading && !error && currentFilteredMessages.length > 0) {
      void handleGenerate();
    }
  }, [isOpen, mode, summary, loading, error, currentFilteredMessages.length, handleGenerate, channelId, selectedDate, lastReadId, targetLang]);

  useEffect(() => {
    if (isOpen && messages.length === 0) {
      setError(t('noMessagesToSummarize'));
    }
  }, [isOpen, messages.length, t]);

  const handleCopy = () => {
    if (!summary) return;
    void navigator.clipboard.writeText(summary).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const hasConnection = !!(settings?.preferences.summarizerConnection || settings?.preferences.defaultConnection);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`${t('summaryTitle')} — #${channelName}`} maxWidth="max-w-xl">
      <div className="space-y-4">
        {/* Scope selector tabs */}
        <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-white/[0.06]">
          <div className="flex bg-white/[0.04] rounded-lg p-0.5 border border-white/[0.06]">
            <button
              type="button"
              disabled={loading}
              onClick={() => handleModeChange('unread')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                mode === 'unread'
                  ? 'bg-accent-primary/20 text-accent-primary border border-accent-primary/30'
                  : 'text-txt-tertiary hover:text-txt-secondary'
              }`}
            >
              📩 {t('summaryModeUnread')}
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={() => handleModeChange('date')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                mode === 'date'
                  ? 'bg-accent-primary/20 text-accent-primary border border-accent-primary/30'
                  : 'text-txt-tertiary hover:text-txt-secondary'
              }`}
            >
              📅 {t('summaryModeDate')}
            </button>
          </div>

          <div className="flex items-center gap-2">
            {mode === 'date' && (
              <ChatDatePicker
                value={selectedDate}
                disabled={loading}
                messageDates={messageDates}
                onChange={handleDateChange}
              />
            )}
            <span className="text-[11px] text-txt-tertiary">
              {t('messagesCountFound', { total: currentFilteredMessages.length })}
            </span>
          </div>
        </div>

        {!hasConnection ? (
          <div className="rounded-lg border border-accent-amber/30 bg-accent-amber/10 p-4 text-sm text-txt-secondary space-y-2">
            <p>{t('missing-connection', { defaultValue: 'Please configure an AI connection first.' })}</p>
            <button
              type="button"
              className="rounded px-3 py-1.5 bg-accent-primary text-white text-xs font-medium hover:bg-accent-primary-hover transition-colors"
              onClick={() => {
                onClose();
                useUIStore.getState().openModal('userSettings', { tab: 'translation' });
              }}
            >
              {t('title')}
            </button>
          </div>
        ) : loading ? (
          <div className="flex flex-col items-center justify-center py-12 space-y-3">
            <div className="w-6 h-6 border-2 border-accent-primary border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-txt-tertiary">{t('generatingSummary')}</p>
          </div>
        ) : error ? (
          <div className="space-y-3 py-4">
            <p role="alert" className="rounded-lg border border-accent-rose/30 bg-accent-rose/10 p-3 text-sm text-txt-danger">
              {error}
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                className="px-3 py-1.5 rounded bg-accent-primary hover:bg-accent-primary-hover text-xs font-medium text-white transition-colors"
                onClick={() => void handleGenerate()}
              >
                {t('generateSummary')}
              </button>
            </div>
          </div>
        ) : summary ? (
          <div className="space-y-4">
            <div className="max-h-[calc(60*var(--app-vh))] overflow-y-auto rounded-lg bg-white/[0.03] border border-white/[0.06] p-4 text-sm text-txt-primary whitespace-pre-wrap leading-relaxed select-text">
              {summary}
            </div>
            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                className="px-3 py-1.5 rounded text-xs text-txt-tertiary hover:text-txt-primary hover:bg-white/[0.06] transition-colors"
                onClick={() => void handleGenerate()}
              >
                {t('regenerate')}
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="px-4 py-2 rounded bg-accent-primary hover:bg-accent-primary-hover text-xs font-medium text-white transition-colors"
                  onClick={handleCopy}
                >
                  {copied ? t('copied') : t('copySummary')}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-10 space-y-3">
            <p className="text-xs text-txt-tertiary">
              {mode === 'date'
                ? t('messagesCountFound', { total: currentFilteredMessages.length })
                : t('summaryPromptHelp')}
            </p>
            <button
              type="button"
              disabled={currentFilteredMessages.length === 0}
              className={`px-4 py-2 rounded text-xs font-medium text-white transition-colors ${
                currentFilteredMessages.length === 0
                  ? 'bg-accent-primary/40 cursor-not-allowed text-white/50'
                  : 'bg-accent-primary hover:bg-accent-primary-hover shadow-sm'
              }`}
              onClick={() => void handleGenerate()}
            >
              {t('generateSummary')}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
