import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { useMessageTranslation } from './useMessageTranslation';

type MessageTranslationView = ReturnType<typeof useMessageTranslation>;

interface TranslationTextProps {
  translation: MessageTranslationView;
  children: ReactNode;
}

function TranslationFeedback({ translation }: Pick<TranslationTextProps, 'translation'>) {
  const { t } = useTranslation('translation');
  const { entry } = translation;
  if (!entry) return null;

  if (entry.state === 'loading') {
    return (
      <div className="mt-1 text-xs text-txt-tertiary" role="status">
        {t('translating')}
      </div>
    );
  }

  if (entry.state === 'error') {
    return (
      <div className="mt-1 text-xs text-txt-danger" role="alert">
        {entry.message}
        {translation.translate && (
          <button type="button" className="underline ml-1" onClick={translation.translate}>
            {t('retry')}
          </button>
        )}
      </div>
    );
  }

  if (entry.result.kind === 'skipped') {
    return (
      <div className="mt-1 text-xs text-txt-tertiary">
        {t('skippedNotText')}
      </div>
    );
  }

  return null;
}

export function TranslationText({ translation, children }: TranslationTextProps) {
  const { t } = useTranslation('translation');
  const { entry, showOriginal, isCollapsed, toggleCollapse } = translation;
  const translatedText =
    entry?.state === 'done' && entry.result.kind === 'translated' ? entry.result.text : null;

  return (
    <div>
      {translatedText ? (
        <>
          {(showOriginal || isCollapsed) && children}
          {!isCollapsed && (
            // Render model output strictly as plain React text: never active Markdown or HTML.
            <div
              className={
                showOriginal
                  ? 'mt-2 border-l-2 border-accent-primary/40 pl-3 text-txt-secondary whitespace-pre-wrap'
                  : 'whitespace-pre-wrap'
              }
              data-testid="message-translation"
            >
              {translatedText}
            </div>
          )}
          <div className="mt-1 flex gap-2 text-xs text-txt-tertiary select-none">
            <span>{t('translated')}</span>
            <button type="button" className="hover:underline" onClick={toggleCollapse}>
              {showOriginal
                ? isCollapsed
                  ? t('expandTranslation')
                  : t('collapseTranslation')
                : isCollapsed
                  ? t('viewTranslation')
                  : t('viewOriginal')}
            </button>
          </div>
        </>
      ) : (
        children
      )}
      <TranslationFeedback translation={translation} />
    </div>
  );
}
