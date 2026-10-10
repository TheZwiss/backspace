import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { useMessageTranslation } from './useMessageTranslation';
import { translationErrorText } from './errorText';

type MessageTranslation = ReturnType<typeof useMessageTranslation>;
type TextProps = { translation: MessageTranslation; children: ReactNode };
const SKIP_LABELS = {
  'same-language': 'skipped.same-language',
  'not-text': 'skipped.not-text',
  'uncertain-language': 'skipped.uncertain-language',
} as const;
function TranslationFeedback({ translation }: Pick<TextProps, 'translation'>) {
  const { t } = useTranslation('translation');
  const { entry } = translation;
  if (!entry) return null;
  if (entry.state === 'loading')
    return (
      <div className="mt-1 text-xs text-txt-tertiary" role="status">
        {t('translating')}
      </div>
    );
  if (entry.state === 'error')
    return (
      <div className="mt-1 text-xs text-txt-danger" role="alert">
        {translationErrorText(entry.error)}{' '}
        <button className="underline" onClick={translation.translate}>
          {t('retry')}
        </button>
      </div>
    );
  if (!entry.automatic && entry.result.kind === 'skipped')
    return <div className="mt-1 text-xs text-txt-tertiary">{t(SKIP_LABELS[entry.result.reason])}</div>;
  return null;
}
function TranslatedBody({ translation, text, children }: TextProps & { text: string }) {
  const { t } = useTranslation('translation');
  const [originalKey, setOriginalKey] = useState<string | null>(null);
  const { cacheKey, showOriginal } = translation;
  const viewingOriginal = originalKey === cacheKey;
  return (
    <>
      {(showOriginal || viewingOriginal) && children}
      {(!viewingOriginal || showOriginal) && (
        // Model output is text, never active Markdown/HTML: no injected links, images or mentions.
        <div
          className={
            showOriginal
              ? 'mt-2 border-l-2 border-accent-primary/40 pl-3 text-txt-secondary whitespace-pre-wrap'
              : 'whitespace-pre-wrap'
          }
          data-testid="message-translation"
        >
          {text}
        </div>
      )}
      <div className="mt-1 flex gap-2 text-xs text-txt-tertiary select-none">
        <span>{t('translated')}</span>
        {!showOriginal && (
          <button
            className="hover:underline"
            onClick={() => setOriginalKey(viewingOriginal ? null : cacheKey)}
          >
            {viewingOriginal ? t('viewTranslation') : t('viewOriginal')}
          </button>
        )}
      </div>
    </>
  );
}
export function TranslationText({ translation, children }: TextProps) {
  const { entry } = translation;
  const result = entry?.state === 'done' && entry.result.kind === 'translated' ? entry.result.text : null;
  return (
    <div ref={translation.anchorRef}>
      {result ? (
        <TranslatedBody translation={translation} text={result}>
          {children}
        </TranslatedBody>
      ) : (
        children
      )}
      <TranslationFeedback translation={translation} />
    </div>
  );
}
