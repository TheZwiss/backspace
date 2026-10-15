import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';
import { useTranslationSettings } from './useMessageTranslation';
import { sendTranslationCommand } from './translationStore';
import { translationErrorText } from './errorText';

import type { ComposerAction } from '@backspace/shared/translation';
import { DEFAULT_COMPOSER_ACTIONS, getActionDisplayLabel, getTargetLanguageName } from './composerPresets';
import { getLanguage } from '../../i18n';

interface ComposerAssistantPopoverProps {
  open: boolean;
  onClose: () => void;
  draftText: string;
  onApply: (text: string) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

export function ComposerAssistantPopover({
  open,
  onClose,
  draftText,
  onApply,
  anchorRef,
}: ComposerAssistantPopoverProps) {
  const { t, i18n } = useTranslation('translation');
  const popoverRef = useRef<HTMLDivElement>(null);
  const { accountId, settings } = useTranslationSettings();
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { style } = useFloatingPosition(anchorRef, popoverRef, {
    placement: 'top',
    offset: 8,
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, onClose, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  const configuredActions = settings?.preferences.composerActions ?? DEFAULT_COMPOSER_ACTIONS;
  const activeActions = configuredActions.filter((a) => a.enabled);

  const handleAction = async (action: ComposerAction) => {
    if (!draftText.trim()) {
      setError(t('emptyDraftPrompt'));
      return;
    }
    if (!accountId) return;

    setLoadingAction(action.id);
    setError(null);

    const currentLang = i18n?.resolvedLanguage ?? i18n?.language ?? getLanguage();
    const targetLangName = getTargetLanguageName(currentLang);
    const languageInstruction =
      action.id === 'translateToEnglish'
        ? 'Output the translated English text directly without any introductory, conversational, or explanatory remarks.'
        : `Language requirement: Output the final revised text strictly in ${targetLangName}. Output the revised text directly without any introductory, conversational, or explanatory remarks.`;
    const systemPrompt = `${action.systemPrompt}\n\n${languageInstruction}`;

    const reply = await sendTranslationCommand({
      action: 'aiGenerate',
      accountId,
      systemPrompt,
      userPrompt: draftText,
      connectionId: settings?.preferences.composerConnection,
    });

    setLoadingAction(null);
    if (reply.ok && 'outputText' in reply) {
      onApply(reply.outputText);
      onClose();
    } else if (!reply.ok) {
      setError(translationErrorText(reply));
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      ref={popoverRef}
      style={style}
      className="fixed z-[300] w-72 rounded-xl bg-surface-base/95 backdrop-blur-md border border-white/[0.08] shadow-2xl p-3 space-y-2.5 animate-slide-up text-txt-primary"
    >
      <div className="flex items-center justify-between pb-1 border-b border-white/[0.06]">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-txt-primary">
          <span>✨</span>
          <span>{t('composerAssistant')}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-txt-tertiary hover:text-txt-primary text-xs p-1"
          aria-label={t('cancel')}
        >
          ✕
        </button>
      </div>

      {error && (
        <p role="alert" className="text-xs text-txt-danger bg-accent-rose/10 border border-accent-rose/20 rounded p-2">
          {error}
        </p>
      )}

      <div className={activeActions.length === 1 ? 'flex flex-col gap-1.5' : 'grid grid-cols-2 gap-1.5'}>
        {activeActions.map((action) => {
          const isLoading = loadingAction === action.id;
          return (
            <button
              key={action.id}
              type="button"
              disabled={!!loadingAction}
              onClick={() => void handleAction(action)}
              className="flex items-center gap-2 p-2 rounded-lg bg-white/[0.03] hover:bg-white/[0.08] border border-white/[0.04] text-left transition-colors disabled:opacity-50 text-xs"
            >
              <span className="text-sm shrink-0">{isLoading ? '⏳' : action.icon ?? '✨'}</span>
              <span className="truncate font-medium">{getActionDisplayLabel(action, t)}</span>
            </button>
          );
        })}
      </div>

      {activeActions.length === 0 && (
        <p className="text-xs text-txt-tertiary p-2 text-center">
          {t('noEnabledActions')}
        </p>
      )}

      {loadingAction && (
        <div className="flex items-center justify-center gap-2 pt-1 text-xs text-txt-tertiary">
          <div className="w-3.5 h-3.5 border-2 border-accent-primary border-t-transparent rounded-full animate-spin" />
          <span>{t('applying')}</span>
        </div>
      )}
    </div>,
    document.body,
  );
}
